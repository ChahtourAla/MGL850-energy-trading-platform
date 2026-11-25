/**
 * Build links only from the verified proof endpoint's already-resolved
 * HashScan transaction URL. A raw tx hash or a DB confirmation is not proof.
 */
export function verifiedHederaTransactionLink(proof: {
  status: string;
  transactionHash: string | null;
  explorerUrl: string | null;
}): {
  url: string;
  hederaTransactionId: string;
  evmTransactionHash: string;
} | null {
  if (proof.status !== 'VERIFIED_ON_CHAIN') return null;

  const { transactionHash, explorerUrl } = proof;

  if (!transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) {
    return null;
  }

  // No arbitrary host, redirect, path, query or fragment from a response.
  const prefix = 'https://hashscan.io/testnet/transaction/';

  if (
    !explorerUrl ||
    !/^https:\/\/hashscan\.io\/testnet\/transaction\/0\.0\.\d+(?:%40|@|-)\d+(?:\.|-)\d+$/i.test(
      explorerUrl,
    )
  ) {
    return null;
  }

  const hederaTransactionId = decodeURIComponent(explorerUrl.slice(prefix.length));

  if (!/^0\.0\.\d+(?:@|-)\d+(?:\.|-)\d+$/.test(hederaTransactionId)) {
    return null;
  }

  return { url: explorerUrl, hederaTransactionId, evmTransactionHash: transactionHash };
}
