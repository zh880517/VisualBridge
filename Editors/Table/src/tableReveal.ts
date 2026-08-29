export const TABLE_REVEAL_MESSAGE_TYPE = "revealTableRow";
export const TABLE_REVEAL_RESULT_MESSAGE_TYPE = "tableRevealResult";

export interface TableRevealTarget {
  readonly sheetId: string;
  readonly rowId: string;
}

export interface TableRevealRequest {
  readonly type: typeof TABLE_REVEAL_MESSAGE_TYPE;
  readonly requestId: string;
  readonly target: TableRevealTarget;
}

export interface TableRevealResult {
  readonly type: typeof TABLE_REVEAL_RESULT_MESSAGE_TYPE;
  readonly requestId: string;
  readonly found: boolean;
  readonly message?: string;
}

export interface TableRevealRecipient<T> {
  readonly value: T;
  readonly mailbox: TableRevealMailbox;
  readonly active: boolean;
  readonly visible: boolean;
}

export class TableRevealMailbox {
  private sequence = 0;
  private ready = false;
  private pending: TableRevealRequest | undefined;

  public enqueue(target: TableRevealTarget): TableRevealRequest {
    this.pending = {
      type: TABLE_REVEAL_MESSAGE_TYPE,
      requestId: `table-reveal-${++this.sequence}`,
      target,
    };
    return this.pending;
  }

  public markReady(): void {
    this.ready = true;
  }

  public markUnavailable(): void {
    this.ready = false;
  }

  public get isReady(): boolean {
    return this.ready;
  }

  public get deliverable(): TableRevealRequest | undefined {
    return this.ready ? this.pending : undefined;
  }

  public get pendingTarget(): TableRevealTarget | undefined {
    return this.pending?.target;
  }

  public cancel(): void {
    this.pending = undefined;
  }

  public acknowledge(requestId: string): boolean {
    if (requestId !== this.pending?.requestId) {
      return false;
    }
    this.pending = undefined;
    return true;
  }
}

export function chooseReadyTableRevealRecipient<T>(
  recipients: readonly TableRevealRecipient<T>[],
): T | undefined {
  const available = recipients.filter(
    (recipient) => recipient.mailbox.isReady && recipient.mailbox.pendingTarget === undefined,
  );
  return available.find((recipient) => recipient.active && recipient.visible)?.value
    ?? available.find((recipient) => recipient.visible)?.value
    ?? available[0]?.value;
}
