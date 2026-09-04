import { generateKeyPairSync } from "node:crypto";

export interface Ed25519KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Generate an Ed25519 keypair as PEM strings. Private key never leaves the issuer. */
export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
