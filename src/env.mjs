// OPENAI_CUA_* env vars were renamed OAI_CUA_*. For one release the old names
// still work: each is copied to its new name unless that is already set.
// Imported by lib.mjs, which every module that reads the env imports first.
for (const [k, v] of Object.entries(process.env))
  if (k.startsWith("OPENAI_CUA_") && process.env["OAI" + k.slice(6)] === undefined) process.env["OAI" + k.slice(6)] = v;
