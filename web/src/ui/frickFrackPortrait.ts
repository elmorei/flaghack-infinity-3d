/** Original pixel wizard, animated with CSS. No fetched art or per-frame canvas allocation. */
export function frickFrackPortrait(): string {
  return `<svg viewBox="0 0 64 80" shape-rendering="crispEdges" aria-hidden="true">
    <path fill="#10172e" d="M0 0h64v80H0z"/>
    <g class="ff-portrait-spark" fill="#f8d477"><path d="M8 10h2v6H8zM6 12h6v2H6zM52 28h2v6h-2zM50 30h6v2h-6zM46 6h2v2h-2zM12 43h2v2h-2z"/></g>
    <g class="ff-portrait-breathe">
      <path fill="#392658" d="M12 80V62h6v-6h28v6h6v18z"/>
      <path fill="#7650a6" d="M18 80V62h8v-6h12v6h8v18z"/>
      <path fill="#b68ed4" d="M20 64h4v16h-4zM42 64h3v16h-3z"/>
      <path fill="#d6a775" d="M20 30h24v26H20zM17 38h3v9h-3zM44 38h3v9h-3z"/>
      <path fill="#efd0a6" d="M24 32h16v20H24z"/>
      <path fill="#ecede2" d="M19 45h5v5h16v-5h5v15h-5v5h-4v6h-8v-6h-4v-5h-5z"/>
      <path fill="#b2bdc8" d="M21 52h3v10h-3zM40 52h3v10h-3zM29 60h3v9h-3z"/>
      <g class="ff-portrait-blink" fill="#23203b"><path d="M24 39h4v3h-4zM36 39h4v3h-4z"/></g>
      <path fill="#f5eddd" d="M23 35h7v2h-7zM34 35h7v2h-7z"/>
      <path fill="#bd865f" d="M30 41h4v7h-4z"/>
      <path class="ff-portrait-mouth" fill="#643c4d" d="M29 51h6v2h-6z"/>
      <path fill="#ececdf" d="M24 48h16v3H24z"/>
      <path fill="#31204f" d="M12 29h40v6H12zM19 23h27v6H19zM22 16h20v7H22zM26 8h12v8H26zM30 3h8v5H30z"/>
      <path fill="#7551a3" d="M22 24h20v5H22zM25 17h13v7H25zM29 9h6v8H29z"/>
      <path fill="#f5d174" d="M20 27h25v3H20zM31 16h3v7h-3zM29 18h7v3h-7zM18 67h2v6h-2zM16 69h6v2h-6zM44 72h3v3h-3z"/>
    </g></svg>`;
}
