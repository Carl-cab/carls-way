// Development-only settlement processor test endpoint.
// Phase A4: Validate state transitions and idempotency without side effects.
// Returns 404 in production when VERCEL environment var is set.

import { NextResponse } from 'next/server';
import SettlementProcessor from '@/lib/settlement/SettlementProcessor';
import type { NormalizedEvent, SettlementStatus, SettlementEventType } from '@/lib/settlement/types';

type TestCase = {
  name: string;
  intentId: string;
  currentStatus: SettlementStatus;
  nextStatus: SettlementStatus;
  eventType: string;
  isIdempotent: boolean;
  expectValid: boolean;
};

const TEST_CASES: TestCase[] = [
  {
    name: 'Valid transition: confirmed → submitted',
    intentId: 'test-1',
    currentStatus: 'confirmed',
    nextStatus: 'submitted',
    eventType: 'submitted',
    isIdempotent: false,
    expectValid: true,
  },
  {
    name: 'Valid transition: posted → settled',
    intentId: 'test-2',
    currentStatus: 'posted',
    nextStatus: 'settled',
    eventType: 'settled',
    isIdempotent: false,
    expectValid: true,
  },
  {
    name: 'Invalid transition: confirmed → settled',
    intentId: 'test-3',
    currentStatus: 'confirmed',
    nextStatus: 'settled',
    eventType: 'settled',
    isIdempotent: false,
    expectValid: false,
  },
  {
    name: 'Invalid transition: settled → submitted',
    intentId: 'test-4',
    currentStatus: 'settled',
    nextStatus: 'submitted',
    eventType: 'submitted',
    isIdempotent: false,
    expectValid: false,
  },
  {
    name: 'Valid transition: settled → returned',
    intentId: 'test-5',
    currentStatus: 'settled',
    nextStatus: 'returned',
    eventType: 'returned',
    isIdempotent: false,
    expectValid: true,
  },
  {
    name: 'Idempotent retry: settled (already final)',
    intentId: 'test-6',
    currentStatus: 'settled',
    nextStatus: 'settled',
    eventType: 'settled',
    isIdempotent: true,
    expectValid: true,
  },
];

export async function GET() {
  // Block in production
  if (process.env.VERCEL) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const processor = new SettlementProcessor();
  const results = [];

  for (const tc of TEST_CASES) {
    const eventType: SettlementEventType = tc.eventType as SettlementEventType;
    const event: NormalizedEvent = {
      provider: 'test',
      provider_event_id: `event-${tc.intentId}`,
      provider_reference_id: tc.intentId,
      eventType,
      timestamp: new Date(),
      isRetry: tc.isIdempotent,
    };

    const outcome = await processor.processSettlementEvent(
      tc.intentId,
      tc.currentStatus,
      event,
      tc.isIdempotent,
    );

    const passed =
      tc.expectValid === !outcome.error &&
      (tc.expectValid ? outcome.nextStatus !== tc.currentStatus : outcome.nextStatus === tc.currentStatus);

    results.push({
      testName: tc.name,
      passed,
      currentStatus: tc.currentStatus,
      nextStatus: outcome.nextStatus,
      transition: outcome.transition,
      wasIdempotent: outcome.wasIdempotent,
      shouldUpdateBalance: outcome.shouldUpdateBalance,
      shouldCreateLedgerEntry: outcome.shouldCreateLedgerEntry,
      reason: outcome.reason,
      error: outcome.error,
    });
  }

  const allPassed = results.every(r => r.passed);

  return NextResponse.json(
    {
      allPassed,
      totalTests: results.length,
      passedTests: results.filter(r => r.passed).length,
      results,
    },
    { status: 200 },
  );
}

export async function POST(request: Request) {
  if (process.env.VERCEL) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = await request.json();
    const processor = new SettlementProcessor();

    const eventType: SettlementEventType = (body.eventType || 'settled') as SettlementEventType;
    const event: NormalizedEvent = {
      provider: body.provider || 'test',
      provider_event_id: body.provider_event_id || `event-${Date.now()}`,
      provider_reference_id: body.provider_reference_id || body.intentId,
      eventType,
      timestamp: new Date(),
      isRetry: body.isIdempotent || false,
    };

    const outcome = await processor.processSettlementEvent(
      body.intentId || 'test-intent',
      body.currentStatus || 'confirmed',
      event,
      body.isIdempotent || false,
    );

    return NextResponse.json({
      success: true,
      outcome,
    });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 400 },
    );
  }
}
