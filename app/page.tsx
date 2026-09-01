import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthUser } from '@/lib/auth';

export default async function RootPage() {
  const user = await getAuthUser();
  if (user) redirect('/feed');

  return (
    <main className="min-h-screen bg-gradient-to-b from-blue-50 to-white flex items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <div className="text-5xl mb-6">🍁</div>
        <h1 className="text-4xl font-bold text-gray-900">Manna</h1>
        <p className="mt-3 text-gray-600 leading-relaxed">
          The easiest way to send, request, and split money with friends in Canada.
        </p>

        <Link
          href="/register"
          className="mt-10 block w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3.5 rounded-xl shadow-sm transition"
        >
          Get Started
        </Link>

        <Link
          href="/login"
          className="mt-3 block w-full border border-gray-300 text-gray-700 font-semibold py-3.5 rounded-xl hover:bg-gray-50 transition"
        >
          I Already Have an Account
        </Link>

        <p className="mt-8 text-xs text-gray-400">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </main>
  );
}
