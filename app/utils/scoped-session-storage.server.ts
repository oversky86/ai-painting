import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";

/**
 * Prefixes session ids so apps that share one Session table cannot overwrite
 * each other's offline token for the same shop.
 */
export class ScopedSessionStorage implements SessionStorage {
  constructor(
    private readonly inner: SessionStorage,
    private readonly appKey: string,
  ) {}

  private scoped(id: string) {
    return `${this.appKey}:${id}`;
  }

  private withId(session: Session, id: string) {
    return new Session({ ...session.toObject(), id });
  }

  private belongs(session: Session) {
    return session.id.startsWith(`${this.appKey}:`);
  }

  async storeSession(session: Session): Promise<boolean> {
    return this.inner.storeSession(this.withId(session, this.scoped(session.id)));
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const stored = await this.inner.loadSession(this.scoped(id));
    if (!stored) return undefined;
    return this.withId(stored, id);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(this.scoped(id));
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids.map((id) => this.scoped(id)));
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const rows = await this.inner.findSessionsByShop(shop);
    return rows
      .filter((session) => this.belongs(session))
      .map((session) => this.withId(session, session.id.slice(this.appKey.length + 1)));
  }
}
