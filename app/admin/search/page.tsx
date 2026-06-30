import { Suspense } from 'react';
import { GlobalSearch } from '../components/GlobalSearch';

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="text-center py-8">Loading search...</div>}>
      <GlobalSearch />
    </Suspense>
  );
}
