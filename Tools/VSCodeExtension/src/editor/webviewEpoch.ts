export class WebviewEpoch {
  private value = 0;
  private token: string | undefined;
  private ready = false;

  public begin(token: string): void {
    this.value += 1;
    this.token = token;
    this.ready = false;
  }

  public capture(): number {
    return this.value;
  }

  public invalidate(): void {
    this.value += 1;
    this.token = undefined;
    this.ready = false;
  }

  public isCurrent(captured: number): boolean {
    return captured === this.value;
  }

  public canAcceptReady(token: unknown): token is string {
    return typeof token === "string" && token === this.token && !this.ready;
  }

  public markReady(token: string): boolean {
    if (!this.canAcceptReady(token)) {
      return false;
    }
    this.ready = true;
    return true;
  }

  public acceptsMessage(token: unknown): token is string {
    return this.ready && typeof token === "string" && token === this.token;
  }

  public get currentToken(): string | undefined {
    return this.token;
  }

  public get isReady(): boolean {
    return this.ready;
  }
}
