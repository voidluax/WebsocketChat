import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-24 text-center">
      <h1 className="text-5xl font-black text-sky-400">404</h1>
      <p className="mt-3 text-slate-400">
        That page (or room code) does not exist. Room codes are 4–12 letters and numbers.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-slate-950"
      >
        Back to the lobby
      </Link>
    </main>
  );
}
