import Stripe from 'stripe';
import { config } from './config.js';
import { newId } from './ids.js';

export interface HoldRequest {
  amount: number; // US cents
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
  /** Worker's Stripe Connect account; when set, capture pays them directly. */
  destination?: string;
}

/** Where escrowed money actually sits. hold = authorize, capture = pay out, release = void. */
export interface Rail {
  readonly name: 'stripe' | 'fake';
  hold(req: HoldRequest): Promise<{ id: string }>;
  capture(id: string, metadata: Record<string, string>, idempotencyKey: string): Promise<void>;
  release(id: string, metadata: Record<string, string>, idempotencyKey: string): Promise<void>;
}

/** Stripe manual capture: funds are authorized at accept_bid and only move on capture. */
export class StripeRail implements Rail {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;
  private readonly paymentMethod: string;

  constructor(secretKey: string, paymentMethod: string) {
    if (!/^(sk|rk)_test_/.test(secretKey)) {
      throw new Error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_… or rk_test_…). This service never touches live funds.');
    }
    this.stripe = new Stripe(secretKey);
    this.paymentMethod = paymentMethod;
  }

  async hold(req: HoldRequest) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: req.amount,
        currency: 'usd',
        capture_method: 'manual',
        confirm: true,
        payment_method: this.paymentMethod,
        // API 2026-09-30 dropped payment_method_types; no redirects means no return_url is needed.
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: req.description,
        metadata: req.metadata,
        ...(req.destination ? { transfer_data: { destination: req.destination } } : {}),
      },
      { idempotencyKey: req.idempotencyKey },
    );
    if (pi.status !== 'requires_capture') {
      throw new Error(`card authorization not held (PaymentIntent ${pi.id} is ${pi.status})`);
    }
    return { id: pi.id };
  }

  async capture(id: string, metadata: Record<string, string>, idempotencyKey: string) {
    // Stamp the verdict on the PaymentIntent so the Stripe dashboard tells the story.
    await this.stripe.paymentIntents.update(id, { metadata });
    await this.stripe.paymentIntents.capture(id, {}, { idempotencyKey });
  }

  async release(id: string, metadata: Record<string, string>, idempotencyKey: string) {
    await this.stripe.paymentIntents.update(id, { metadata });
    await this.stripe.paymentIntents.cancel(id, { cancellation_reason: 'abandoned' }, { idempotencyKey });
  }
}

/** In-memory stand-in for tests and offline runs. Same state machine as a manual-capture PaymentIntent. */
export class FakeRail implements Rail {
  readonly name = 'fake' as const;
  readonly intents = new Map<string, { amount: number; status: 'requires_capture' | 'succeeded' | 'canceled'; metadata: Record<string, string> }>();
  private readonly byKey = new Map<string, string>();

  async hold(req: HoldRequest) {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return { id: existing };
    const id = newId('pi_fake', 12);
    this.intents.set(id, { amount: req.amount, status: 'requires_capture', metadata: { ...req.metadata } });
    this.byKey.set(req.idempotencyKey, id);
    return { id };
  }

  async capture(id: string, metadata: Record<string, string>) {
    this.transition(id, 'succeeded', metadata);
  }

  async release(id: string, metadata: Record<string, string>) {
    this.transition(id, 'canceled', metadata);
  }

  private transition(id: string, to: 'succeeded' | 'canceled', metadata: Record<string, string>) {
    const pi = this.intents.get(id);
    if (!pi) throw new Error(`no such PaymentIntent ${id}`);
    if (pi.status === to) return; // idempotent retry
    if (pi.status !== 'requires_capture') throw new Error(`PaymentIntent ${id} is already ${pi.status}`);
    pi.status = to;
    Object.assign(pi.metadata, metadata);
  }
}

export function railFromEnv(): Rail {
  if (config.stripeKey) return new StripeRail(config.stripeKey, config.stripePaymentMethod);
  console.warn('[escrow] STRIPE_SECRET_KEY not set: using the in-memory fake rail. Set an sk_test_ key to hold real Stripe test-mode funds.');
  return new FakeRail();
}
