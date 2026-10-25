import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="muted">That item isn’t in the library. It may have been deleted or renamed.</p>
      <Link href="/">Go home</Link>
    </>
  );
}
