'use client';

import Link from 'next/link';

interface CorrelationIdLinkProps {
  correlationId?: string;
  className?: string;
  showIcon?: boolean;
}

export function CorrelationIdLink({
  correlationId,
  className = '',
  showIcon = true,
}: CorrelationIdLinkProps) {
  if (!correlationId) {
    return <span className="text-gray-400">-</span>;
  }

  return (
    <Link
      href={`/admin/search?q=${encodeURIComponent(correlationId)}`}
      className={`text-red-700 hover:underline ${className}`}
      title="Click to trace this correlation ID"
    >
      {showIcon && <span className="mr-1">🔗</span>}
      {correlationId.substring(0, 12)}...
    </Link>
  );
}

export function CorrelationIdBadge({ correlationId }: { correlationId?: string }) {
  if (!correlationId) return null;

  return (
    <Link
      href={`/admin/search?q=${encodeURIComponent(correlationId)}`}
      className="inline-block rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-200"
      title="Click to trace"
    >
      {correlationId.substring(0, 20)}
    </Link>
  );
}
