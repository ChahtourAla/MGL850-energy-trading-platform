import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WalletCryptoService } from './wallet-crypto.service.js';

const TEST_KEY = Buffer.alloc(32, 42).toString('base64');
const config = { get: (name: string) => name === 'WALLET_ENCRYPTION_KEY_B64' ? TEST_KEY : undefined };
const crypto = new WalletCryptoService(config as never);

describe('B07 wallet encryption', () => {
  it('encrypts/decrypts the exact private key and produces random IVs', () => {
    const user = randomUUID();
    const a = crypto.encrypt(user, 'ECDSA_PRIVATE_KEY_TEST_ONLY');
    const b = crypto.encrypt(user, 'ECDSA_PRIVATE_KEY_TEST_ONLY');
    expect(a.encryptedPrivateKey).not.toContain('ECDSA_PRIVATE_KEY_TEST_ONLY');
    expect(a.encryptionIv).not.toBe(b.encryptionIv);
    expect(crypto.decrypt(user, a)).toBe('ECDSA_PRIVATE_KEY_TEST_ONLY');
    expect(a.keyVersion).toBe(1);
  });
  it('rejects ciphertext tampering', () => {
    const user = randomUUID();
    const data = crypto.encrypt(user, 'test-key');
    const ciphertext = Buffer.from(data.encryptedPrivateKey, 'base64');
    ciphertext[0] ^= 1;
    expect(() => crypto.decrypt(user, { ...data, encryptedPrivateKey: ciphertext.toString('base64') })).toThrow();
  });
  it('rejects tag tampering', () => {
    const user = randomUUID();
    const data = crypto.encrypt(user, 'test-key');
    const tag = Buffer.from(data.encryptionAuthTag, 'base64');
    tag[0] ^= 1;
    expect(() => crypto.decrypt(user, { ...data, encryptionAuthTag: tag.toString('base64') })).toThrow();
  });
  it('rejects another user and unsupported key version', () => {
    const data = crypto.encrypt(randomUUID(), 'test-key');
    expect(() => crypto.decrypt(randomUUID(), data)).toThrow();
    expect(() => crypto.decrypt(randomUUID(), { ...data, keyVersion: 3 })).toThrow();
  });
  it('fails closed when encryption key is missing', () => {
    const invalid = new WalletCryptoService({ get: () => undefined } as never);
    expect(() => invalid.encrypt(randomUUID(), 'test-key')).toThrow();
  });
});
