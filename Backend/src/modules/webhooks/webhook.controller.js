import { WebhookReceiver } from 'livekit-server-sdk';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';
import { env } from '../../config/env.js';
import { handleLiveKitEvent } from './webhook.service.js';

/**
 * LiveKit signs the exact bytes it posts with the API secret, so the raw body
 * is what gets verified — never the parsed JSON.
 *
 * `Authorization` and `Authorize` are both accepted, with or without the
 * `Bearer ` prefix, because the header LiveKit sends differs between versions.
 */
const AUTH_PATTERNS = /sha256|authoriz|signature|jws|jose|claim|issuer/i;

let receiver;

const getReceiver = () => {
  const { apiKey, apiSecret } = env.livekit;

  if (!apiKey || !apiSecret) {
    throw new ApiError(502, 'LIVEKIT_NOT_CONFIGURED', 'LiveKit webhook verification is not configured');
  }

  if (!receiver) receiver = new WebhookReceiver(apiKey, apiSecret);
  return receiver;
};

const rawBodyOf = (req) => {
  const { body } = req;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return '';
};

export const receiveLiveKitWebhook = asyncHandler(async (req, res) => {
  const raw = rawBodyOf(req);

  if (!raw.trim()) {
    throw ApiError.badRequest('WEBHOOK_BODY_MISSING', 'Raw webhook body is required');
  }

  const header = req.get('authorization') || req.get('authorize') || '';
  const token = header.replace(/^bearer\s+/i, '');

  let event;

  try {
    event = await getReceiver().receive(raw, token);
  } catch (err) {
    const message = String(err?.message || '');

    if (AUTH_PATTERNS.test(message)) {
      console.warn(`[webhook] rejected livekit webhook: ${message}`);
      throw new ApiError(401, 'WEBHOOK_UNAUTHORIZED', 'LiveKit webhook signature verification failed');
    }

    // Authenticated, but the signed bytes are not a webhook payload.
    throw ApiError.badRequest('WEBHOOK_MALFORMED', 'LiveKit webhook payload could not be parsed');
  }

  if (!event?.event) {
    throw ApiError.badRequest('WEBHOOK_MALFORMED', 'LiveKit webhook event type is missing');
  }

  // Unknown rooms, unsupported events and duplicate deliveries are all
  // acknowledged: LiveKit only needs to know the webhook arrived safely.
  const result = await handleLiveKitEvent(event);

  console.info(
    `[webhook] handled event=${result.eventType} id=${event.id || '-'} changed=${Boolean(result.changed)}`
  );

  return sendSuccess(res);
});
