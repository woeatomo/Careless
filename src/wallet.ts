import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export class Signer {
  readonly keypair: Keypair;
  readonly owner: string;

  constructor(base58PrivateKey: string) {
    this.keypair = Keypair.fromSecretKey(bs58.decode(base58PrivateKey));
    this.owner = this.keypair.publicKey.toBase58();
  }

  /** Tanda tangani transaksi base64 dari LP Agent (versioned atau legacy). */
  sign = (base64Tx: string): string => {
    const buffer = Buffer.from(base64Tx, "base64");
    try {
      const tx = VersionedTransaction.deserialize(buffer);
      tx.sign([this.keypair]);
      return Buffer.from(tx.serialize()).toString("base64");
    } catch {
      const tx = Transaction.from(buffer);
      tx.partialSign(this.keypair);
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    }
  };
}
