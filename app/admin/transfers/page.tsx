import { Suspense } from 'react';
import { TransfersPage } from '../components/TransfersPage';

export default function Page() {
  return (
    <Suspense fallback={<div className="text-center py-8">Loading transfers...</div>}>
      <TransfersPage />
    </Suspense>
  );
}
