import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const LOGIN_ID = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;

export function validLoginId(value: string): boolean {
  return LOGIN_ID.test(value);
}

export function randomPassword(): string {
  return randomBytes(12).toString("base64url");
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("base64url")): Promise<{ hash: string; salt: string }> {
  const derived = await scrypt(password, salt, 32) as Buffer;
  return { hash: derived.toString("base64url"), salt };
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const derived = await scrypt(password, salt, 32) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
