export function EncodingNotice({ staging }: { staging: boolean }) {
  return (
    <div className="encoding" role="note">
      <p>This file isn't UTF-8 (perhaps Latin-1), so characters moire can't decode show as �.{staging ? " It can only be staged whole." : ""}</p>
    </div>
  );
}
