#!/usr/bin/env node
import { writeFile } from 'fs/promises';
import { Client } from './client.js';
import { run } from './commands.js';
import { configPath, readConfigFile, writeConfigFile } from './config.js';

// nexusctl (#240) — entry point. Everything testable lives in commands.ts.
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

const file = configPath();
const code = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  configFile: file,
  readConfig: () => readConfigFile(file),
  writeConfig: (config) => writeConfigFile(file, config),
  makeClient: (url, token) => new Client(url, token),
  writeFile: (path, bytes) => writeFile(path, bytes),
  signal: controller.signal,
});
process.exit(code);
