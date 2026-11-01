import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { secretsDir, writeSecretFile } from "./tokens.js";
import { readHidden } from "../util/hidden-input.js";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// The one person who may approve an OAuth connection to this server. Only a
// hash of their password is kept.
export function ownerFile(): string {
  return join(secretsDir(), "owner.json");
}

interface OwnerSecret {
  algo: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

const PARAMS = { N: 1 << 15, r: 8, p: 1 };
const KEYLEN = 32;
const MIN_LENGTH = 12;

async function derive(password: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  return scrypt(password, salt, KEYLEN, { ...p, maxmem: 128 * p.N * p.r * 2 });
}

export async function setOwnerPassword(password: string, file = ownerFile()): Promise<void> {
  if (password.length < MIN_LENGTH) throw new Error(`the owner password needs at least ${MIN_LENGTH} characters`);
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  const secret: OwnerSecret = { algo: "scrypt", ...PARAMS, salt: salt.toString("base64"), hash: hash.toString("base64") };
  await writeSecretFile(file, JSON.stringify(secret, null, 2) + "\n");
}

export function ownerIsSet(file = ownerFile()): boolean {
  return existsSync(file);
}

export async function checkOwnerPassword(password: string, file = ownerFile()): Promise<boolean> {
  if (!existsSync(file)) return false;
  const secret = JSON.parse(await readFile(file, "utf8")) as OwnerSecret;
  const expected = Buffer.from(secret.hash, "base64");
  const actual = await derive(password, Buffer.from(secret.salt, "base64"), secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Ask for a password on the terminal without echoing it, or read the first
// line of stdin when it is not a terminal (scripts, `echo … |`).
export async function readPassword(prompt: string): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write(prompt);
  return readHidden();
}
