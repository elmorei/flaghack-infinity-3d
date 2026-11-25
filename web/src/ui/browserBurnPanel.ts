import { BrowserBurn, type InviteStatus } from '../net/browserBurn';
import type { ClientSocket } from '../net/client';
import { MAX_NAME_LENGTH } from '../net/protocol';
import './browserBurnPanel.css';

/** A modal is used so normal game controls do not capture pasted signaling text. */
export class BrowserBurnPanel {
  private readonly burn: BrowserBurn;
  private readonly dialog = document.createElement('dialog');
  private readonly manage = document.createElement('button');
  private readonly handle = document.createElement('input');
  private readonly offer = document.createElement('textarea');
  private readonly answer = document.createElement('textarea');
  private readonly status = document.createElement('p');
  private readonly performance = document.createElement('p');
  private readonly prep = document.createElement('div');
  private readonly hosting = document.createElement('div');
  private readonly pause: HTMLButtonElement;
  private busy = false;

  constructor(join: (name: string, socket: ClientSocket, room: string, welcomed?: () => void) => boolean) {
    this.burn = new BrowserBurn(join, (status) => this.inviteStatus(status), () => this.view());
    this.dialog.className = 'browser-burn';
    this.dialog.setAttribute('aria-label', 'Browser multiplayer preview');
    this.manage.className = 'btn browser-burn-manage';
    this.manage.type = 'button';
    this.manage.textContent = 'Manage browser burn';
    this.manage.hidden = true;
    this.manage.addEventListener('click', () => this.open());
    const title = document.createElement('h2');
    title.textContent = 'Browser multiplayer (preview)';
    const info = document.createElement('p');
    info.textContent = 'A PC is the preferred host. If everyone is on a phone, one person can volunteer. Keep the host tab open and foregrounded. This private preview is for direct connections, normally on the same Wi-Fi. There is no relay, online matchmaking, or automatic host transfer.';
    this.handle.maxLength = MAX_NAME_LENGTH;
    this.handle.autocomplete = 'off';
    this.label(this.prep, 'Browser host handle', this.handle);
    this.button(this.prep, 'Start browser host', async () => {
      await this.burn.startHost(this.name());
      this.view();
      this.notice('Create one offer per guest and send the offer privately.');
    });
    this.button(this.prep, 'Create answer', async () => {
      const answer = await this.burn.createAnswer(this.offer.value.trim(), this.name());
      if (this.status.textContent === 'Working…') {
        this.answer.value = answer;
        this.notice('Send this answer privately to the host. Keep this tab open.');
      }
    });
    this.button(this.prep, 'Cancel waiting', () => {
      this.burn.cancelGuest();
      this.answer.value = '';
      this.notice('Canceled. Ask the host for a fresh offer.');
    });
    this.button(this.hosting, 'Create invite', async () => {
      this.offer.value = this.answer.value = '';
      this.offer.value = await this.burn.createOffer();
      this.notice('Send the offer privately to one guest. Paste their answer and choose Connect guest.');
    });
    this.button(this.hosting, 'Connect guest', async () => {
      await this.burn.applyAnswer(this.answer.value.trim());
      this.offer.value = this.answer.value = '';
      if (this.status.textContent === 'Working…') this.notice('Answer applied. Waiting for the direct connection.');
    });
    this.pause = this.button(this.hosting, 'Pause burn', () => {
      this.notice(this.burn.togglePause() ? 'Burn paused on this host.' : 'Burn resumed.');
      this.view();
    });
    this.button(this.hosting, 'Stop browser host', () => {
      this.burn.stopHost();
      this.offer.value = this.answer.value = '';
      this.view();
      this.notice('Browser host stopped.');
    });
    this.offer.rows = this.answer.rows = 3;
    for (const field of [this.offer, this.answer]) {
      field.spellcheck = false;
      field.autocapitalize = 'none';
    }
    const codes = document.createElement('div');
    this.label(codes, 'Offer code', this.offer);
    this.label(codes, 'Answer code', this.answer);
    this.status.setAttribute('aria-live', 'polite');
    this.performance.setAttribute('role', 'status');
    this.performance.textContent = 'The host could not keep up, so the burn paused for everyone. Keep this tab in front and close other heavy apps or tabs. Try resuming when ready. The burn will pause again if the host still cannot keep up.';
    this.dialog.append(title, info, this.performance, this.prep, this.hosting, codes, this.status);
    this.button(this.dialog, 'Close', () => this.dialog.close());
    // Dialog events never become game input. Native Tab and Escape still operate normally.
    for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup']) {
      this.dialog.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.append(this.dialog, this.manage);
    this.view();
  }

  open(): void {
    this.view();
    if (!this.dialog.open) this.dialog.showModal();
  }

  endHostIfOwned(): void {
    if (!this.burn.hosting) return;
    this.burn.stopHost();
    this.offer.value = this.answer.value = '';
    this.view();
  }

  private inviteStatus(status: InviteStatus): void {
    if (status === 'guest-welcome') { this.dialog.close(); return; }
    if (status === 'offer-expired' || status === 'host-failed' || status === 'guest-failed') {
      this.offer.value = this.answer.value = '';
    }
    const message: Record<Exclude<InviteStatus, 'guest-welcome'>, string> = {
      'offer-expired': 'This offer expired. Create a fresh invite.',
      'host-failed': 'The guest did not join the lobby. Create a fresh invite and try again on the same Wi-Fi.',
      'host-channel': 'Direct connection open. Waiting for the guest to join the lobby.',
      'host-welcome': 'A guest joined the lobby. Create a new invite for the next player.',
      'guest-channel': 'Direct connection open. Waiting for the host to admit you.',
      'guest-failed': 'Could not join the lobby. Ask the host for a fresh invite and keep both tabs open on the same Wi-Fi.',
    };
    this.notice(message[status]);
  }

  private name(): string {
    const name = this.handle.value.trim();
    if (!name) throw new Error('Enter a handle first.');
    return name;
  }
  private notice(text: string): void { this.status.textContent = text; }
  private view(): void {
    const isHost = this.burn.hosting;
    this.prep.hidden = isHost;
    this.hosting.hidden = this.manage.hidden = !isHost;
    this.offer.readOnly = isHost;
    this.answer.readOnly = !isHost;
    const overloaded = this.burn.performancePaused;
    this.performance.hidden = !overloaded;
    this.manage.textContent = overloaded ? 'Burn paused: host performance' : 'Manage browser burn';
    this.pause.textContent = overloaded ? 'Try resuming' : this.burn.paused ? 'Resume burn' : 'Pause burn';
  }
  private button(parent: HTMLElement, text: string, fn: () => unknown): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = text;
    button.addEventListener('click', () => {
      if (this.busy && text !== 'Close') return;
      if (text === 'Close') { this.dialog.close(); return; }
      this.busy = true;
      const prior = this.status.textContent;
      this.notice('Working…');
      Promise.resolve().then(fn).catch((err: unknown) => this.notice(err instanceof Error ? err.message : 'The browser connection could not be set up.'))
        .finally(() => {
          this.busy = false;
          if (this.status.textContent === 'Working…') this.notice(prior ?? '');
        });
    });
    parent.append(button);
    return button;
  }
  private label(parent: HTMLElement, text: string, input: HTMLElement): void {
    const label = document.createElement('label');
    label.append(text, input);
    parent.append(label);
  }
}
