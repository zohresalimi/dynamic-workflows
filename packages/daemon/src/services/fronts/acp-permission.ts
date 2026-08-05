/** The ACP front for `session/request_permission`: unwrap params, call
 * ./../permission-service.ts, wrap the outcome. The ladder is the service's,
 * and behind it EPIC-08's. */
import type * as acp from '@agentclientprotocol/sdk';
import type { PermissionQuery, PermissionService } from '../permission-service.ts';

export function acpPermissionHandlers(
  permission: PermissionService,
): Record<string, (params: never) => unknown> {
  return {
    'session/request_permission': async (params: acp.RequestPermissionRequest) => ({
      outcome: await permission.decide({
        sessionId: params.sessionId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title ?? '',
        toolKind: (params.toolCall.kind ?? 'other') as PermissionQuery['toolKind'],
        locations: params.toolCall.locations ?? [],
        options: params.options as PermissionQuery['options'],
      }),
    }),
  } as Record<string, (params: never) => unknown>;
}
