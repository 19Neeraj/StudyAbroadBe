import { Types } from 'mongoose';
import { logger } from '../../config/logger.js';
import { aiProvider } from '../../integrations/ai/index.js';
import { callingProvider } from '../../integrations/calling/index.js';
import { storage } from '../../integrations/storage/index.js';
import { transcriptionProvider } from '../../integrations/transcription/index.js';
import { enqueue, registerJob, scheduleRepeating } from '../../jobs/queue.js';
import { emitTo, rooms } from '../../sockets/index.js';
import { addDays } from '../../utils/time.js';
import { recordAudit } from '../audit/audit.service.js';
import { getCommunicationPolicy } from '../integrations/communicationPolicy.model.js';
import { credentialsOf } from '../integrations/integration.service.js';
import { IntegrationModel } from '../integrations/integration.model.js';
import { UserModel } from '../users/user.model.js';
import { LeadModel } from '../leads/lead.model.js';
import { AiSummaryModel } from './aiSummary.model.js';
import { CallModel } from './call.model.js';
import { CallRecordingModel } from './recording.model.js';
import { TranscriptModel } from './transcript.model.js';

/**
 * Recording → transcript → AI summary (spec §48). Each step is its own retried job, so a slow or
 * failing provider never blocks the API or the previous step's result.
 */
type JobData = { organizationId: string; callId: string };
const ids = (d: JobData) => ({ organizationId: new Types.ObjectId(d.organizationId), callId: new Types.ObjectId(d.callId) });

async function integration(organizationId: Types.ObjectId, kind: 'calling' | 'transcription' | 'ai') {
  return IntegrationModel.findOne({ organizationId, kind, enabled: true }).select('+secrets').lean();
}

async function ingestRecording(data: JobData) {
  const { organizationId, callId } = ids(data);
  const call = await CallModel.findOne({ organizationId, _id: callId }).select('+providerRecordingUrl provider duration recordingConsent counsellorId recordingId');
  if (!call?.providerRecordingUrl || call.recordingId) return;
  const policy = await getCommunicationPolicy(organizationId);
  if (!policy.recordingEnabled) return;

  const rec = await CallRecordingModel.findOneAndUpdate(
    { organizationId, callId },
    { $setOnInsert: { organizationId, callId, provider: call.provider, consentStatus: call.recordingConsent?.status, retentionUntil: addDays(new Date(), policy.retentionDays) } },
    { upsert: true, returnDocument: 'after' },
  );
  try {
    const conn = await integration(organizationId, 'calling');
    const provider = callingProvider(call.provider);
    if (!provider.getRecording) throw new Error(`${call.provider} cannot fetch recordings`);
    const audio = await provider.getRecording(call.providerRecordingUrl, conn ? credentialsOf(conn) : { config: {}, secrets: {} });
    const ext = audio.contentType.includes('wav') ? 'wav' : 'mp3';
    const key = `${organizationId.toString()}/calls/${callId.toString()}/recording.${ext}`;
    const stored = await storage.putObject({ key, body: audio.body, contentType: audio.contentType });
    await CallRecordingModel.updateOne(
      { organizationId, _id: rec._id },
      { status: 'stored', fileKey: key, fileSize: stored.size, mimeType: audio.contentType, duration: call.duration, $unset: { error: 1 } },
    );
    // The provider copy is no longer needed by the CRM; drop the URL so it cannot leak.
    await CallModel.updateOne({ organizationId, _id: callId }, { recordingId: rec._id, $unset: { providerRecordingUrl: 1 } });
  } catch (err) {
    await CallRecordingModel.updateOne({ organizationId, _id: rec._id }, { status: 'failed', error: (err as Error).message.slice(0, 500) });
    throw err;
  }
  if (policy.transcriptionEnabled) await enqueue('call.transcribe', data, { jobId: `tr:${data.callId}` });
}

async function transcribe(data: JobData) {
  const { organizationId, callId } = ids(data);
  const [call, policy, conn] = await Promise.all([
    CallModel.findOne({ organizationId, _id: callId }).select('recordingId transcriptId leadId counsellorId branchId').lean(),
    getCommunicationPolicy(organizationId),
    integration(organizationId, 'transcription'),
  ]);
  const provider = transcriptionProvider(conn?.provider);
  if (!call?.recordingId || call.transcriptId || !policy.transcriptionEnabled || !provider) return;
  const rec = await CallRecordingModel.findOne({ organizationId, _id: call.recordingId, status: 'stored' }).lean();
  if (!rec?.fileKey) return;

  const audio = await storage.getObject(rec.fileKey);
  const result = await provider.transcribe({ body: audio, contentType: rec.mimeType ?? 'audio/mpeg' }, { languages: policy.transcriptionLanguages });
  const fullText = result.segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');
  const transcript = await TranscriptModel.findOneAndUpdate(
    { organizationId, callId },
    {
      organizationId, callId, leadId: call.leadId, counsellorId: call.counsellorId, branchId: call.branchId,
      provider: provider.name, language: result.language, status: 'completed', segments: result.segments, fullText, duration: result.duration,
    },
    { upsert: true, returnDocument: 'after' },
  );
  await CallModel.updateOne({ organizationId, _id: callId }, { transcriptId: transcript._id });
  if (policy.aiSummaryEnabled) await enqueue('call.summarize', data, { jobId: `ai:${data.callId}` });
}

async function summarize(data: JobData) {
  const { organizationId, callId } = ids(data);
  const [call, policy, conn] = await Promise.all([
    CallModel.findOne({ organizationId, _id: callId }).select('transcriptId summaryId leadId counsellorId').lean(),
    getCommunicationPolicy(organizationId),
    integration(organizationId, 'ai'),
  ]);
  const provider = aiProvider(conn?.provider);
  if (!call?.transcriptId || call.summaryId || !policy.aiSummaryEnabled || !provider) return;
  const transcript = await TranscriptModel.findOne({ organizationId, _id: call.transcriptId }).select('fullText language').lean();
  if (!transcript?.fullText) return;
  const [lead, counsellor] = await Promise.all([
    call.leadId ? LeadModel.findOne({ organizationId, _id: call.leadId }).select('fullName').lean() : null,
    call.counsellorId ? UserModel.findOne({ organizationId, _id: call.counsellorId }).select('fullName').lean() : null,
  ]);
  const insights = await provider.summarizeCall({
    transcript: transcript.fullText,
    language: transcript.language ?? undefined,
    context: { studentName: lead?.fullName ?? undefined, counsellorName: counsellor?.fullName ?? undefined },
  });
  const summary = await AiSummaryModel.findOneAndUpdate(
    { organizationId, callId },
    { organizationId, callId, transcriptId: transcript._id, leadId: call.leadId, ...insights, model: `${provider.name}:${provider.model}`, generatedAt: new Date() },
    { upsert: true, returnDocument: 'after' },
  );
  await CallModel.updateOne({ organizationId, _id: callId }, { summaryId: summary._id });
  if (call.counsellorId) emitTo([rooms.user(call.counsellorId.toString())], 'call.summary.ready', { callId: data.callId, leadId: call.leadId?.toString() ?? null });
}

/** Deletes recordings past their retention date (spec §31). Transcripts follow the policy; audit entries remain. */
export async function sweepExpiredRecordings(now = new Date()): Promise<number> {
  const expired = await CallRecordingModel.find({ status: 'stored', retentionUntil: { $lte: now } })
    .setOptions({ skipTenantGuard: true })
    .limit(500)
    .lean();
  for (const rec of expired) {
    try {
      if (rec.fileKey) await storage.deleteObject(rec.fileKey);
      await CallRecordingModel.updateOne({ organizationId: rec.organizationId, _id: rec._id }, { status: 'deleted', deletedAt: now, $unset: { fileKey: 1 } });
      const policy = await getCommunicationPolicy(rec.organizationId);
      if (!policy.keepTranscriptAfterRecordingDeleted) {
        await TranscriptModel.deleteOne({ organizationId: rec.organizationId, callId: rec.callId });
        await AiSummaryModel.deleteOne({ organizationId: rec.organizationId, callId: rec.callId });
        await CallModel.updateOne({ organizationId: rec.organizationId, _id: rec.callId }, { $unset: { transcriptId: 1, summaryId: 1 } });
      }
      await CallModel.updateOne({ organizationId: rec.organizationId, _id: rec.callId }, { $unset: { recordingId: 1 } });
      await recordAudit({ organizationId: rec.organizationId, meta: { userAgent: 'retention-job' } }, {
        entityType: 'call_recording', entityId: rec._id, action: 'recording.retention_deleted', metadata: { callId: rec.callId.toString(), transcriptKept: policy.keepTranscriptAfterRecordingDeleted },
      });
    } catch (err) {
      logger.error({ err, recordingId: rec._id.toString() }, 'Retention delete failed');
    }
  }
  return expired.length;
}

export function registerCallJobs(): void {
  registerJob('call.recording.ingest', ingestRecording, { attempts: 5, backoffMs: 30_000 });
  registerJob('call.transcribe', transcribe, { attempts: 3, backoffMs: 60_000 });
  registerJob('call.summarize', summarize, { attempts: 3, backoffMs: 60_000 });
  registerJob('recordings.retention', async () => {
    await sweepExpiredRecordings();
  }, { attempts: 1 });
}

export async function scheduleCallJobs(): Promise<void> {
  await scheduleRepeating('recordings.retention', 60 * 60_000);
}
