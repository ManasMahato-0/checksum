import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="card empty">
      <h2>Page not found</h2>
      <p>That page doesn’t exist.</p>
      <Link to="/" className="btn">
        Back to overview
      </Link>
    </div>
  );
}
