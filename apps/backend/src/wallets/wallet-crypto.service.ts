import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EncryptedWalletKey {
  encryptedPrivateKey: string;
  encryptionIv: string;
  encryptionAuthTag: string;
  keyVersion: number;
}

/** Server-side authenticated encryption. Never return any of these fields via HTTP. */
@Injectable()
export class WalletCryptoService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private encryptionKey(): Buffer {
    const encoded = this.config.get<string>('WALLET_ENCRYPTION_KEY_B64');
    if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
      throw new ServiceUnavailableException('Wallet encryption is not configured');
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new ServiceUnavailableException('Wallet encryption is not configured');
    }
    return key;
  }

  private aad(userId: string, keyVersion: number): Buffer {
    return Buffer.from(`mgl850:wallet:${userId}:v${keyVersion}`, 'utf8');
  }

  encrypt(userId: string, plaintextPrivateKey: string): EncryptedWalletKey {
    const keyVersion = 1;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(this.aad(userId, keyVersion));
    const encrypted = Buffer.concat([
      cipher.update(plaintextPrivateKey, 'utf8'),
      cipher.final(),
    ]);
    return {
      encryptedPrivateKey: encrypted.toString('base64'),
      encryptionIv: iv.toString('base64'),
      encryptionAuthTag: cipher.getAuthTag().toString('base64'),
      keyVersion,
    };
  }

  /** Internal only. Do not expose as an endpoint, log, or return in response DTOs. */
  decrypt(userId: string, data: EncryptedWalletKey): string {
    if (data.keyVersion !== 1) {
      throw new Error('Unsupported wallet key version');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      Buffer.from(data.encryptionIv, 'base64'),
    );
    decipher.setAAD(this.aad(userId, data.keyVersion));
    decipher.setAuthTag(Buffer.from(data.encryptionAuthTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(data.encryptedPrivateKey, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
