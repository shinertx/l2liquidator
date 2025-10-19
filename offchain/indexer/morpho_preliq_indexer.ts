import type { AppConfig } from '../infra/config';
import type { Candidate } from './aave_indexer';
import { streamMorphoBlueCandidates } from './morphoblue_indexer';

type PreLiqCandidate = Candidate & { preliq: NonNullable<Candidate['preliq']> };

/**
 * Legacy adapter that forwards to the unified morphoblue pre-liq stream.
 * Continues to accept the historical callback signature used by earlier scripts.
 */
export async function pollPreLiqOffers(
	cfg: AppConfig,
	onCandidate: (candidate: PreLiqCandidate) => void | Promise<void>
): Promise<void> {
	for await (const candidate of streamMorphoBlueCandidates(cfg)) {
		if (!candidate?.preliq) continue;
		await onCandidate(candidate as PreLiqCandidate);
	}
}
