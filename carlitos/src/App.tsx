import { useState } from 'react'
import './App.css'
import { Sidebar, type NavKey } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { Overview } from '@/sections/Overview'
import { Agents } from '@/sections/Agents'
import { Sources } from '@/sections/Sources'
import { Activity } from '@/sections/Activity'
import { Finance } from '@/sections/Finance'
import { Digest } from '@/sections/Digest'
import { useAsync } from '@/hooks/useAsync'
import { getActivity, getRuntimeStatus } from '@/lib/mock'

const sections: Record<NavKey, () => React.ReactNode> = {
  overview: Overview,
  agents: Agents,
  sources: Sources,
  activity: Activity,
  finance: Finance,
  digest: Digest,
}

function App() {
  const [active, setActive] = useState<NavKey>('overview')
  const runtime = useAsync(getRuntimeStatus)
  const activity = useAsync(getActivity)

  const pendingCount = activity.data?.filter((a) => a.pending).length ?? 0
  const Section = sections[active]

  return (
    <div className="flex min-h-screen bg-background bg-grid">
      <Sidebar active={active} onNavigate={setActive} pendingCount={pendingCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar active={active} onNavigate={setActive} runtime={runtime.data} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          <Section />
        </main>
      </div>
    </div>
  )
}

export default App
