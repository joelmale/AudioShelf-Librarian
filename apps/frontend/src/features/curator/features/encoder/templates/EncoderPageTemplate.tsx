import type { ReactNode } from 'react';

/** Template: page scaffold for the encoder (title + toolbar + body slots). */
export function EncoderPageTemplate({
  title,
  toolbar,
  children,
}: {
  title: string;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1>{title}</h1>
        <span className="spacer" />
        {toolbar}
      </div>
      {children}
    </div>
  );
}
