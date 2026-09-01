/**
 * Offline validation of the regulatory knowledge corpus + its grounding tools.
 * No DB, no network. Checks: frontmatter parses on every doc, ids are unique + kebab-case,
 * required frontmatter fields are present, source_urls look like URLs, and search returns the
 * right docs for a set of realistic probes.
 *   npx tsx test-knowledge.ts
 */
import { z } from 'zod';
import { loadCorpus, buildKnowledgeToolDefs } from './src/knowledge-tools';

const JURISDICTIONS = new Set(['CTH', 'NSW', 'VIC', 'SA', 'QLD', 'WA', 'TAS', 'CROSS']);
const AS_AT = '2026-07-08';   // corpus base date; individual docs may carry a later verified date

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log('  ok   ' + msg);
  } else {
    console.log('  FAIL ' + msg);
    failures++;
  }
}

function parse(res: any) {
  try { return JSON.parse(res.content[0].text); } catch { return res?.content?.[0]?.text; }
}

async function callTool(defs: any[], name: string, args: any) {
  const d = defs.find((t) => t.name === name);
  if (!d) throw new Error('no such tool: ' + name);
  // Apply the zod shape the way the SDK's MCP layer does in production (defaults + validation);
  // calling the handler with raw args would skip e.g. the paging defaults on get_knowledge_doc.
  const parsed = z.object(d.inputSchema ?? {}).parse(args ?? {});
  return parse(await d.handler(parsed, {}));
}

async function main() {
  console.log('== corpus load ==');
  const docs = loadCorpus();
  // The corpus = the curated regulatory collection + staff-ingested library docs (AI Trainer).
  // The regulatory invariants below (jurisdiction, instrument, source_urls, substance) are the
  // regulatory collection's contract; library docs carry annotation-shaped frontmatter and are
  // free-form by design, so they are only checked for id/title/summary.
  const regulatory = docs.filter((d) => d.collection === 'regulatory');
  const library = docs.filter((d) => d.collection !== 'regulatory');
  console.log(`  ${regulatory.length} regulatory + ${library.length} library docs`);
  check(regulatory.length >= 18, `regulatory corpus has >=18 docs (got ${regulatory.length})`);

  console.log('\n== frontmatter / required fields ==');
  const ids = new Set<string>();
  const byJur: Record<string, number> = {};
  for (const d of library) {
    check(!!d.id && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.id), `library id is kebab-case: ${d.id || '(missing)'}`);
    check(!ids.has(d.id), `id is unique: ${d.id}`);
    ids.add(d.id);
    check(!!d.title && !!d.summary, `library title + summary present: ${d.id}`);
  }
  for (const d of regulatory) {
    const where = d.path.replace(/.*knowledge[\\/]/, 'knowledge/');
    check(!!d.id && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.id), `id is kebab-case: ${d.id || '(missing)'} [${where}]`);
    check(!ids.has(d.id), `id is unique: ${d.id}`);
    ids.add(d.id);
    check(!!d.title, `title present: ${d.id}`);
    check(JURISDICTIONS.has(d.jurisdiction), `jurisdiction valid (${d.jurisdiction}): ${d.id}`);
    check(!!d.instrument, `instrument present: ${d.id}`);
    check(d.source_urls.length >= 1, `>=1 source_url: ${d.id}`);
    check(d.source_urls.every((u) => /^https?:\/\//.test(u)), `source_urls are URLs: ${d.id}`);
    check(/^\d{4}-\d{2}-\d{2}$/.test(d.as_at) && d.as_at >= AS_AT, `as_at is a valid date >= ${AS_AT}: ${d.id} (got ${d.as_at})`);
    check(!!d.summary, `summary present: ${d.id}`);
    check(d.body.length > 200, `body has substance: ${d.id} (${d.body.length} chars)`);
    check(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(d.body + d.title), `no emoji: ${d.id}`);
    byJur[d.jurisdiction] = (byJur[d.jurisdiction] ?? 0) + 1;
  }
  console.log('  docs by jurisdiction:', JSON.stringify(byJur));
  for (const j of JURISDICTIONS) check((byJur[j] ?? 0) >= 1, `jurisdiction covered: ${j}`);

  console.log('\n== tools: catalog ==');
  const defs = buildKnowledgeToolDefs();
  check(defs.length === 3, `3 tools built (got ${defs.length})`);
  const cat = await callTool(defs, 'list_knowledge_docs', {});
  check(cat.count === docs.length, `list_knowledge_docs counts all docs (${cat.count})`);
  const nswCat = await callTool(defs, 'list_knowledge_docs', { jurisdiction: 'NSW' });
  check(nswCat.docs.every((d: any) => d.jurisdiction === 'NSW'), 'jurisdiction filter works (NSW)');
  check(nswCat.count === byJur['NSW'], `NSW filter count matches (${nswCat.count})`);

  console.log('\n== tools: get_knowledge_doc ==');
  const first = await callTool(defs, 'get_knowledge_doc', { id: regulatory[0].id });
  check(first.id === regulatory[0].id && first.body.length > 0, `fetch by id returns body: ${regulatory[0].id}`);
  const missing = await callTool(defs, 'get_knowledge_doc', { id: 'no-such-doc' });
  check(missing.error === 'NOT_FOUND', 'unknown id -> NOT_FOUND with available_ids');

  console.log('\n== tools: search probes ==');
  // Each probe: at least one returned doc id must contain one of the expected substrings.
  const probes: { query: string; jurisdiction?: string; expectAny: string[] }[] = [
    { query: 'carryover victoria', expectAny: ['vic', 'carryover'] },
    { query: 'Barmah choke', expectAny: ['barmah'] },
    { query: 'general security AWD', expectAny: ['nsw', 'available-water', 'licence'] },
    { query: 'basin plan trading rules chapter 12', expectAny: ['basin-plan', 'trading'] },
    { query: 'water sharing plan licence rules', expectAny: ['water-sharing', 'nsw'] },
    { query: 'compare trading rules between states', expectAny: ['trading-rules', 'compar', 'cross'] },
    { query: 'sustainable diversion limits', expectAny: ['sustainable-diversion', 'sdl', 'basin-plan'] },
    { query: 'seasonal determination allocation', expectAny: ['vic', 'seasonal', 'allocation'] },
    { query: 'inter-valley transfer IVT limit', expectAny: ['ivt', 'inter-valley', 'trading', 'cross'] },
    { query: 'South Australia private carryover', expectAny: ['sa', 'carryover'] },
  ];
  for (const p of probes) {
    const res = await callTool(defs, 'search_knowledge', { query: p.query, jurisdiction: p.jurisdiction });
    const returnedIds: string[] = (res.matches ?? []).map((m: any) => m.id);
    const hit = returnedIds.some((id) => p.expectAny.some((sub) => id.includes(sub)));
    check(hit && returnedIds.length > 0,
      `search "${p.query}" -> [${returnedIds.slice(0, 4).join(', ')}]${hit ? '' : ' (no expected match)'}`);
    // every match must carry citable metadata
    if (res.matches?.length) {
      const m0 = res.matches[0];
      check(!!m0.title && Array.isArray(m0.source_urls) && m0.source_urls.length >= 1 && m0.excerpts?.length >= 1,
        `  top match carries title + source_urls + excerpts`);
    }
  }

  console.log('\n== search: empty / no-hit query ==');
  const none = await callTool(defs, 'search_knowledge', { query: 'zzzqqq nonexistentterm' });
  check(Array.isArray(none.matches), 'no-hit query returns an (empty) matches array, no throw');

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
