import React from "react";

type Props = { html: string; title: string };

export function Page037({ html, title }: Props) {
  const rows = Array.from({ length: 25 }, (_, idx) => <li key={idx}>{title}-{idx}</li>);
  return (
    <main>
      <h1>{title}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} /> {/* STRESS_ID: MR2-F05 */}
      <ul>{rows}</ul>
    </main>
  );
}
