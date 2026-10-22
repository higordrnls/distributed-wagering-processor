import { Injectable } from "@nestjs/common";

/**
 * Extension point for provider authentication.
 *
 * Production implementation:
 * - Validate JWTs issued by an external Identity Provider.
 * - Extract the authenticated provider identity.
 * - Reject requests whose providerId does not match that identity.
 *
 * Authentication is intentionally not enabled in this challenge.
 */
export abstract class ProviderIdentityPort {
  abstract assertProviderAccess(providerId: string): void | Promise<void>;
}

/**
 * Explicit no-op implementation for the unauthenticated challenge mode.
 *
 * WARNING: Does not authenticate or authorize requests.
 * Replace with an IdP-backed implementation before production deployment.
 */
@Injectable()
export class UnauthenticatedProviderIdentity
  implements ProviderIdentityPort
{
  assertProviderAccess(_providerId: string): void {
    // Authentication is deliberately disabled.
  }
}
