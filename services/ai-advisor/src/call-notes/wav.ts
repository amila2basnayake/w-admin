/**
 * Minimal WAV (RIFF/PCM) handling — pure, dependency-free, offline-testable.
 *
 * Why hand-rolled: the PBX hands us WAV files (Asterisk MixMonitor: typically 8 kHz 16-bit PCM,
 * mono or one leg per channel), the provider caps one upload at 25 MB / ~23 min, and we do not
 * want an ffmpeg dependency on the sidecar host. Splitting PCM on frame boundaries and rewriting
 * the 44-byte header is all that is needed, so that is all this does.
 */

export interface WavInfo {
  /** 1 = PCM. Anything else (A-law 6, mu-law 7, GSM 49, extensible 0xFFFE) is reported, not decoded. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** Average bytes per second from the header (what a compressed WAV's duration is read from). */
  byteRate: number;
  /** Byte offset of the PCM payload within the file. */
  dataOffset: number;
  dataBytes: number;
  /** Duration: exact for PCM; for other formats derived from byteRate (0 when the header has none). */
  seconds: number;
  /** True when we can split/mix it ourselves (PCM, 8/16/24/32-bit, sane header). */
  pcm: boolean;
}

/** Parse the RIFF header. Returns null for anything that is not a WAV. */
export function parseWav(buf: Buffer): WavInfo | null {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number; blockAlign: number; byteRate: number } | null = null;
  let dataOffset = -1, dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (body + 16 > buf.length) return null;
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const byteRate = buf.readUInt32LE(body + 8);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format tag is the first two bytes of the sub-format GUID.
      if (format === 0xFFFE && size >= 26 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels, sampleRate, bitsPerSample, blockAlign, byteRate };
    } else if (id === 'data') {
      dataOffset = body;
      // Streaming writers sometimes leave size 0 / 0xFFFFFFFF; clamp to what is actually present.
      if (size === 0 || size === 0xFFFFFFFF || body + size > buf.length) size = Math.max(0, buf.length - body);
      dataBytes = size;
      break;                                   // data is conventionally last; stop scanning
    }
    off = body + size + (size & 1);            // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) return null;
  const { format, channels, sampleRate, bitsPerSample, byteRate } = fmt;
  const blockAlign = fmt.blockAlign || (channels * Math.ceil(bitsPerSample / 8));
  const pcm = format === 1 && channels >= 1 && channels <= 8 && sampleRate >= 4000 && sampleRate <= 192000
    && [8, 16, 24, 32].includes(bitsPerSample) && blockAlign === channels * (bitsPerSample / 8);
  // PCM: exact from the frame size. Compressed (GSM/WAV49, A-law, mu-law, ...): the header's average
  // byte rate is the only duration we have — blockAlign*sampleRate is meaningless for those.
  const seconds = pcm
    ? ((blockAlign > 0 && sampleRate > 0) ? dataBytes / blockAlign / sampleRate : 0)
    : (byteRate > 0 ? dataBytes / byteRate : 0);
  return { format, channels, sampleRate, bitsPerSample, blockAlign, byteRate, dataOffset, dataBytes, seconds, pcm };
}

/**
 * Are the channels of a multi-channel PCM WAV really the same signal? Asterisk MixMonitor can write
 * a "stereo" file that is the same mix on both channels (dual-mono), and a leg-per-channel file
 * where the two channels carry different voices. Transcribing dual-mono per channel would produce
 * every line twice under two labels, so the caller mixes it down and diarizes instead.
 *
 * Measures, over a strided sample of the frames, the normalised cross-correlation between channel
 * 0 and each other channel (scale-invariant: a gain difference between copies does not fool it)
 * plus the residual energy ratio E(L-R)/max(E(L),E(R)). 16-bit PCM only (what the PBX writes).
 */
export interface ChannelSimilarity {
  /** min over pairs (0,c) of the normalised cross-correlation; 1 = identical shape. */
  correlation: number;
  /** max over pairs of E(ch0 - chC) / max(E(ch0), E(chC)); 0 = identical. */
  residualRatio: number;
  /** RMS per channel (of 32767). */
  rms: number[];
  /** Enough signal to judge at all (both channels above the silence floor)? */
  measurable: boolean;
  /** The verdict the transcription path acts on. */
  dualMono: boolean;
}
export function channelSimilarity(buf: Buffer, info: WavInfo, opts: { silenceRms?: number; minCorrelation?: number } = {}): ChannelSimilarity {
  const silenceRms = opts.silenceRms ?? 40, minCorr = opts.minCorrelation ?? 0.95;
  const none: ChannelSimilarity = { correlation: 0, residualRatio: 1, rms: [], measurable: false, dualMono: false };
  if (!info.pcm || info.bitsPerSample !== 16 || info.channels < 2) return none;
  const pcm = pcmOf(buf, info);
  const frames = Math.floor(pcm.length / info.blockAlign);
  if (frames < 8) return none;
  // Stride so a one-hour file costs a few million reads, not a hundred million.
  const stride = Math.max(1, Math.floor(frames / 400_000));
  const ch = info.channels;
  const sum = new Array<number>(ch).fill(0), sq = new Array<number>(ch).fill(0);
  const xy = new Array<number>(ch).fill(0), diffSq = new Array<number>(ch).fill(0);
  let n = 0;
  for (let f = 0; f < frames; f += stride) {
    const base = f * info.blockAlign;
    const v0 = pcm.readInt16LE(base);
    sum[0] += v0; sq[0] += v0 * v0;
    for (let c = 1; c < ch; c++) {
      const v = pcm.readInt16LE(base + c * 2);
      sum[c] += v; sq[c] += v * v; xy[c] += v0 * v; const d = v0 - v; diffSq[c] += d * d;
    }
    n++;
  }
  const rms = sq.map((s) => Math.sqrt(s / Math.max(1, n)));
  let corrMin = 1, residMax = 0, measurable = true;
  for (let c = 1; c < ch; c++) {
    if (rms[0] < silenceRms || rms[c] < silenceRms) { measurable = false; continue; }
    const m0 = sum[0] / n, mc = sum[c] / n;
    const cov = xy[c] / n - m0 * mc;
    const v0 = sq[0] / n - m0 * m0, vc = sq[c] / n - mc * mc;
    const corr = (v0 > 0 && vc > 0) ? cov / Math.sqrt(v0 * vc) : 0;
    const resid = diffSq[c] / Math.max(sq[0], sq[c], 1);
    corrMin = Math.min(corrMin, corr);
    residMax = Math.max(residMax, resid);
  }
  if (!measurable) return { correlation: 0, residualRatio: 1, rms, measurable: false, dualMono: false };
  return { correlation: corrMin, residualRatio: residMax, rms, measurable: true, dualMono: corrMin >= minCorr };
}

/** Standard 44-byte PCM header + payload. */
export function buildWav(pcm: Buffer, opts: { channels: number; sampleRate: number; bitsPerSample: number }): Buffer {
  const { channels, sampleRate, bitsPerSample } = opts;
  const blockAlign = channels * (bitsPerSample / 8);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function pcmOf(buf: Buffer, info: WavInfo): Buffer {
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
}

/** One mono WAV per channel (interleaved frames de-interleaved). PCM only. */
export function splitChannels(buf: Buffer, info: WavInfo): Buffer[] {
  if (!info.pcm) throw new Error('splitChannels: not PCM');
  const bps = info.bitsPerSample / 8;
  const pcm = pcmOf(buf, info);
  const frames = Math.floor(pcm.length / info.blockAlign);
  const outs: Buffer[] = [];
  for (let c = 0; c < info.channels; c++) {
    const mono = Buffer.alloc(frames * bps);
    for (let f = 0; f < frames; f++) {
      pcm.copy(mono, f * bps, f * info.blockAlign + c * bps, f * info.blockAlign + (c + 1) * bps);
    }
    outs.push(buildWav(mono, { channels: 1, sampleRate: info.sampleRate, bitsPerSample: info.bitsPerSample }));
  }
  return outs;
}

/** Sum-to-mono (average of channels). 16-bit PCM only (what the PBX writes). */
export function mixToMono(buf: Buffer, info: WavInfo): Buffer {
  if (!info.pcm || info.bitsPerSample !== 16) throw new Error('mixToMono: expects 16-bit PCM');
  if (info.channels === 1) return buildWav(Buffer.from(pcmOf(buf, info)), { channels: 1, sampleRate: info.sampleRate, bitsPerSample: 16 });
  const pcm = pcmOf(buf, info);
  const frames = Math.floor(pcm.length / info.blockAlign);
  const mono = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < info.channels; c++) acc += pcm.readInt16LE(f * info.blockAlign + c * 2);
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / info.channels))), f * 2);
  }
  return buildWav(mono, { channels: 1, sampleRate: info.sampleRate, bitsPerSample: 16 });
}

export interface WavChunk { wav: Buffer; startSec: number; seconds: number; }

/**
 * Split a PCM WAV into consecutive chunks no longer than maxSeconds and no larger than maxBytes,
 * cutting on frame boundaries. Each chunk is a complete standalone WAV. Offsets are exact, so
 * transcript timestamps can be re-based onto the whole recording.
 */
export function splitWav(buf: Buffer, info: WavInfo, opts: { maxSeconds: number; maxBytes: number; snapToSilence?: boolean }): WavChunk[] {
  if (!info.pcm) throw new Error('splitWav: not PCM');
  const bytesPerSec = info.blockAlign * info.sampleRate;
  const maxByDur = Math.floor(opts.maxSeconds * bytesPerSec);
  const maxByBytes = Math.floor(Math.max(0, opts.maxBytes - 44));
  let step = Math.min(maxByDur, maxByBytes);
  step -= step % info.blockAlign;
  if (step <= 0) throw new Error('splitWav: limits too small');
  const pcm = pcmOf(buf, info);
  const snap = opts.snapToSilence !== false && info.bitsPerSample === 16;
  const out: WavChunk[] = [];
  let pos = 0;
  while (pos < pcm.length) {
    let end = Math.min(pcm.length, pos + step);
    // Cutting mid-word makes the STT hallucinate a fragment at the seam; move the cut to the
    // quietest 50 ms in the last 20% of the window instead.
    if (snap && end < pcm.length) end = quietestCut(pcm, info, pos + Math.floor(step * 0.8), end);
    end -= (end - pos) % info.blockAlign;
    if (end <= pos) break;
    const slice = Buffer.from(pcm.subarray(pos, end));
    out.push({
      wav: buildWav(slice, { channels: info.channels, sampleRate: info.sampleRate, bitsPerSample: info.bitsPerSample }),
      startSec: pos / bytesPerSec,
      seconds: slice.length / bytesPerSec,
    });
    pos = end;
  }
  return out;
}

/** Byte offset (frame-aligned) of the quietest 50 ms frame in [from, to) of 16-bit PCM. */
function quietestCut(pcm: Buffer, info: WavInfo, from: number, to: number): number {
  const frameBytes = Math.floor(info.sampleRate * 0.05) * info.blockAlign;
  if (frameBytes <= 0 || to - from < frameBytes * 2) return to;
  let best = to, bestE = Infinity;
  const hop = info.blockAlign * 2;                    // every 2nd frame, all channels
  for (let p = from - (from % info.blockAlign); p + frameBytes <= to; p += frameBytes) {
    let e = 0;
    for (let f = p; f + info.blockAlign <= p + frameBytes; f += hop) {
      for (let c = 0; c < info.channels; c++) { const v = pcm.readInt16LE(f + c * 2); e += v * v; }
    }
    if (e < bestE) { bestE = e; best = p; }
  }
  return best;
}

/**
 * Integer-factor downsample of 16-bit mono PCM by box averaging (24 kHz -> 8 kHz with factor 3).
 * Only used to make phone-like fixtures from TTS output; not on the transcription path.
 */
export function downsample16(pcm: Buffer, factor: number): Buffer {
  if (factor <= 1) return pcm;
  const inFrames = Math.floor(pcm.length / 2);
  const outFrames = Math.floor(inFrames / factor);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    let acc = 0;
    for (let k = 0; k < factor; k++) acc += pcm.readInt16LE((i * factor + k) * 2);
    out.writeInt16LE(Math.round(acc / factor), i * 2);
  }
  return out;
}

/** Interleave two equal-rate 16-bit mono PCM buffers into stereo (shorter one zero-padded). */
export function interleaveStereo(left: Buffer, right: Buffer): Buffer {
  const frames = Math.max(Math.floor(left.length / 2), Math.floor(right.length / 2));
  const out = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) {
    const l = f * 2 + 1 < left.length ? left.readInt16LE(f * 2) : 0;
    const r = f * 2 + 1 < right.length ? right.readInt16LE(f * 2) : 0;
    out.writeInt16LE(l, f * 4);
    out.writeInt16LE(r, f * 4 + 2);
  }
  return out;
}

/** Sniff the container from magic bytes so a mislabelled PBX download still gets the right extension. */
export function sniffAudio(buf: Buffer): { ext: string; mime: string } | null {
  if (!buf || buf.length < 12) return null;
  const a4 = buf.toString('ascii', 0, 4);
  if (a4 === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (a4 === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (a4 === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  if (buf.toString('ascii', 0, 3) === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { ext: 'mp4', mime: 'audio/mp4' };
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return { ext: 'webm', mime: 'audio/webm' };
  return null;
}
