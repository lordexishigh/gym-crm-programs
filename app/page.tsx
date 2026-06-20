import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-8 px-5 py-12 text-center">
      <div className="flex flex-col gap-3">
        <span className="text-sm font-semibold uppercase tracking-widest text-brand">
          Alpha CRM
        </span>
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
          Training programs your members can actually open.
        </h1>
        <p className="mx-auto max-w-xl text-base text-slate-600 sm:text-lg">
          A multi-tenant CRM for Cyprus gyms. Trainers build programs and assign
          them to members, who view them on a mobile-first portal — with every
          gym&apos;s data isolated at the database layer.
        </p>
      </div>

      <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-lg bg-brand px-6 py-3 text-base font-medium text-white shadow-sm transition hover:bg-brand-dark"
        >
          Staff sign in
        </Link>
        <Link
          href="/login?role=member"
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-6 py-3 text-base font-medium text-slate-700 transition hover:bg-slate-100"
        >
          Member portal
        </Link>
      </div>
    </main>
  );
}
