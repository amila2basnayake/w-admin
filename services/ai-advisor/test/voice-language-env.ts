// Live multilingual itest environment: the live env plus a multilingual language set (must be set
// before src/voice/config.ts loads — imports are hoisted, so this file's body runs after its own
// import and before the test file's next import).
import './voice-itest-env';
process.env.AIADVISOR_VOICE_LANGUAGES = 'en-AU,vi-VN,it-IT,el-GR,hi-IN,zh-CN,tr-TR,ar-SA';
export {};
