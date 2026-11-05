/** Local journal stores only hashes, numeric page IDs and fixed status codes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkObsResult } from './observation-result.mts';
import { pageId } from './observation-policy.mts';
export type Receipt = {
    digest: string;
    ids: string[];
    result?: string;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function receiptKey(session: string, turn: string): string { return hash(`${session}\n${turn}`); }
export function contentDigest(value: unknown): string { return hash(JSON.stringify(value)); }
export interface ReceiptStore {
    claim(key: string, digest: string): {
        receipt: Receipt;
        save: () => void;
        release: () => void;
    };
}
export function receiptStore(root: string): ReceiptStore {
    return { claim(key, digest) {
            if (!/^[a-f0-9]{64}$/.test(key))
                throw new Error('receipt-unavailable');
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())
                throw new Error('receipt-unavailable');
            const file = path.join(root, `${key}.json`);
            // Exclusive ownership also serializes independent MCP processes. A stale lock
            // after a crash fails closed and requires explicit inspection, never retry.
            const lock = path.join(root, `${key}.lock`);
            fs.mkdirSync(lock, { mode: 0o700 });
            let receipt: Receipt;
            try {
                if (fs.lstatSync(file, { throwIfNoEntry: false })) {
                    const stat = fs.lstatSync(file);
                    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096)
                        throw new Error('receipt-unavailable');
                    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Receipt;
                    if (!raw || typeof raw !== 'object' || Object.keys(raw).sort((left, right) => {
                      if (left < right) return -1;
                      if (left > right) return 1;
                      return 0;
                    }).join() !== 'digest,ids,result' || typeof raw.result !== 'string')
                        throw new Error('receipt-unavailable');
                    if (!/^[a-f0-9]{64}$/.test(raw.digest) || !Array.isArray(raw.ids)
                        || !raw.ids.every(pageId) || raw.ids.length > 20
                        || (raw.result !== undefined && (typeof raw.result !== 'string' || raw.result.length > 1200)))
                        throw new Error();
                    if (raw.result !== undefined) {
                        const parsed = checkObsResult(raw.result);
                        if ('problem' in parsed || parsed.status === 'empty' || parsed.ids.join() !== raw.ids.join())
                            throw new Error();
                    }
                    receipt = raw;
                }
                else
                    receipt = { digest, ids: [] };
            }
            catch {
                fs.rmdirSync(lock);
                throw new Error('receipt-unavailable');
            }
            return { receipt, save() {
                    const pending = path.join(lock, 'pending');
                    fs.writeFileSync(pending, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
                    fs.renameSync(pending, file);
                }, release() { fs.rmdirSync(lock); } };
        } };
}
