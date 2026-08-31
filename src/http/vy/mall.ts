// Vylagrets ENDA HTML-verktyg (Etapp 2a). Ingen templatemotor, inga ramverk,
// inga externa resurser: template literals + en inline-CSS, precis som
// ytor_server.py. Vyn ska kännas som redovisningens/ytornas.
//
// TVÅ regler som hela vylagret vilar på:
//   1. KRAV-6: ALL dynamisk text går genom esc() här. Arkivdata innehåller
//      markdown, citattecken och länkar och får aldrig bli injicerad HTML.
//   2. KRAV-5: proveniens() är enda sättet att skriva ut en aktör. Märkningen
//      kommer ur events/comments-kolumnerna (aktor_typ + aktor_namn) — aldrig
//      ur fri text — och ingen rad lämnas omärkt.

import type { Aktor } from '../../lib/aktor.js';

const ERSATTNING: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** KRAV-6: enda escape-funktionen. `null`/`undefined` blir tom sträng. */
export function esc(varde: unknown): string {
  if (varde === null || varde === undefined) return '';
  return String(varde).replace(/[&<>"']/g, (tecken) => ERSATTNING[tecken]!);
}

// ---- Tokenblocket (Designlyft KRAV-1) --------------------------------------
//
// ENDA stilkällan i hela vylagret, och enda stället där en färg-, längd- eller
// tidsliteral får stå. Tre lager, i den ordning de får refereras:
//
//   1. PRIMITIVA (--p-*)  råvärden. Refereras BARA av lager 2.
//   2. SEMANTISKA         roll i gränssnittet (--yta, --text-svag, --linje …).
//                         Det är detta lager mörkt läge pekar om — och bara det,
//                         därför står det inte en enda literal i @media-blocket.
//   3. KOMPONENT          namngivna mått för kort, chip, fält, knapp, rubrik.
//
// Reglerna under blocket refererar ALDRIG lager 1:s FARGER. Byts pappret ut byts en rad.
const CSS = `
/* Designkontraktet, kopia 3 av 3. Kanon: /opt/redovisning/server/src/http/view/html.ts.
   Sjalvvardade typsnitt, OFL 1.1, inget externt anrop. Filerna ar ARENDEVYNS
   EGNA under /opt/arenden/assets/typsnitt och serveras pa vyns egen rutt —
   en delad sokvag mellan systemen hade varit precis den bindning K-9 forbjuder.
   Licenserna ligger pa /vy/typsnitt/LICENSE-public-sans.txt och
   /vy/typsnitt/LICENSE-ibm-plex-mono.txt. */
@font-face{font-family:"Public Sans";font-style:normal;font-weight:400;
font-display:swap;src:url("/vy/typsnitt/public-sans-latin-400-normal.woff2") format("woff2")}
@font-face{font-family:"Public Sans";font-style:normal;font-weight:600;
font-display:swap;src:url("/vy/typsnitt/public-sans-latin-600-normal.woff2") format("woff2")}
@font-face{font-family:"Public Sans";font-style:normal;font-weight:700;
font-display:swap;src:url("/vy/typsnitt/public-sans-latin-700-normal.woff2") format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:400;
font-display:swap;src:url("/vy/typsnitt/ibm-plex-mono-latin-400-normal.woff2") format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:600;
font-display:swap;src:url("/vy/typsnitt/ibm-plex-mono-latin-600-normal.woff2") format("woff2")}
:root{
color-scheme:light dark;

/* 0 — KONTRAKTET. Enda stallet i hela vylagret dar en FARG far sta som
   literal, och enda lagret morkt lage pekar om. Vardena ar kanons, tecken
   for tecken; prov/designparitet.py fäller den dag de driftar isar. */
--paper:oklch(0.984 0.005 95);--surface:oklch(0.997 0.002 95);
--surface-2:oklch(0.963 0.006 95);
--ink:oklch(0.27 0.014 255);--ink-2:oklch(0.44 0.012 255);--ink-3:oklch(0.56 0.010 255);
--line:oklch(0.905 0.008 95);--line-2:oklch(0.845 0.010 95);
--accent:oklch(0.49 0.074 216);--accent-ink:oklch(0.44 0.078 218);
--accent-weak:oklch(0.955 0.021 216);--on-accent:oklch(0.99 0.004 216);
--pos:oklch(0.50 0.088 155);--pos-weak:oklch(0.955 0.030 155);
--neg:oklch(0.525 0.118 33);--neg-weak:oklch(0.958 0.028 40);
--ai:oklch(0.60 0.104 71);--ai-ink:oklch(0.50 0.098 68);
--ai-weak:oklch(0.957 0.038 78);--ai-line:oklch(0.86 0.070 78);
--focus:oklch(0.58 0.13 232);
--radius:12px;--radius-sm:8px;--radius-pill:999px;
--traff:2.75rem;--maxw:1080px;
--shadow-1:0 1px 2px oklch(0.4 0.03 255 / 0.05), 0 2px 6px oklch(0.4 0.03 255 / 0.05);
--shadow-2:0 2px 6px oklch(0.4 0.03 255 / 0.06), 0 12px 28px oklch(0.4 0.03 255 / 0.08);
--sans:"Public Sans", sans-serif;
--mono:"IBM Plex Mono", monospace;
--display:"IBM Plex Mono", monospace;

/* 1 — PRIMITIVA: matt, typskala, rorelse. Fargprimitiverna ar BORTA — lager 0
   ar nu husets enda fargkalla, och det var hela poangen med lyftet. */
--p-typ-1:.833rem;--p-typ-2:1rem;--p-typ-3:1.2rem;--p-typ-4:1.44rem;
--p-vikt-1:400;--p-vikt-2:600;--p-vikt-3:680;
--p-rad-tat:1.25;--p-rad-1:1.4;--p-rad-2:1.65;
--p-spar-tat:-.012em;--p-spar-vid:.06em;
--p-sans:var(--sans);--p-mono:var(--mono);--p-display:var(--display);
--p-rym-1:.25rem;--p-rym-2:.5rem;--p-rym-3:.75rem;--p-rym-4:1rem;
--p-rym-5:1.5rem;--p-rym-6:2rem;--p-rym-7:3rem;
--p-radie-1:var(--radius-sm);--p-radie-2:var(--radius);--p-radie-rund:var(--radius-pill);
--p-linje-1:1px;--p-linje-2:2px;--p-understryk:.15em;
--p-matt:34rem;--p-sida:44rem;--p-traff:var(--traff);--p-falt:14rem;--p-dold:1px;
--p-utanfor:-110%;
--p-tid-1:120ms;--p-tid-2:170ms;--p-kurva:cubic-bezier(.23,1,.32,1);
--p-tryck-stor:.995;--p-tryck:.97;
--p-lager-header:9;--p-lager-hopp:30;

/* 2 — SEMANTISKA: roll i granssnittet. Varje rad pekar rakt in i lager 0. */
--yta:var(--paper);--yta-upphojd:var(--surface);--yta-sankt:var(--surface-2);
--text:var(--ink);--text-svag:var(--ink-3);
/* TRE linjer, inte en. Kanon skiljer pa avdelaren (line), den interaktiva
   kanten (line-2) och en linje som SJALV bar betydelse. Den sista ar
   citatstrecket: dar ar linjen budskapet, och da racker inte en harfin
   avdelare (WCAG 1.4.11). Den far darfor den dampade texttonen. */
--linje:var(--line);--linje-2:var(--line-2);--linje-stark:var(--ink-3);
--accent-text:var(--on-accent);
--fokus:var(--focus);--markering:var(--accent-weak);
--skugga-lyft:var(--shadow-1);
/* 2 — SEMANTISKA: proveniens (AI Act art. 50). Husets tre utfall och de fyra
   aktorstyperna delar nu kanons hues: agenten bar ockran som betyder "vantar
   pa en manniska", manniskan det botaniska gronet, det okanda lerrodet. */
--prov-agent-yta:var(--ai-weak);--prov-agent-text:var(--ai-ink);
--prov-agent-linje:var(--ai-line);
--prov-manniska-yta:var(--pos-weak);--prov-manniska-text:var(--pos);
--prov-manniska-linje:var(--pos);
--prov-system-yta:var(--surface-2);--prov-system-text:var(--ink-2);
--prov-system-linje:var(--line-2);
--prov-okand-yta:var(--neg-weak);--prov-okand-text:var(--neg);
--prov-okand-linje:var(--neg);

/* 3 — KOMPONENT */
--rubrik-1:var(--p-typ-4);--rubrik-2:var(--p-typ-3);--rubrik-3:var(--p-typ-2);
--brodtext:var(--p-typ-2);--meta:var(--p-typ-1);
--kort-yta:var(--yta-upphojd);--kort-linje:var(--linje);--kort-radie:var(--p-radie-2);
--kort-luft:var(--p-rym-4);--kort-mellanrum:var(--p-rym-2);
--chip-hojd:var(--p-traff);--chip-luft:var(--p-rym-3);--chip-radie:var(--p-radie-rund);
--falt-hojd:var(--p-traff);--falt-radie:var(--p-radie-1);
--knapp-yta:var(--accent);--knapp-text:var(--accent-text);
--fokus-tjocklek:var(--p-linje-2);--fokus-avstand:var(--p-linje-2)
}
/* Morkt lage pekar om LAGER 0 och bara det — samma disciplin som forut, en
   vaning ner. Semantiken och komponenterna foljer med av sig sjalva. */
@media(prefers-color-scheme:dark){:root{
--paper:oklch(0.195 0.012 260);--surface:oklch(0.235 0.013 260);
--surface-2:oklch(0.275 0.014 260);
--ink:oklch(0.935 0.006 95);--ink-2:oklch(0.76 0.010 95);--ink-3:oklch(0.64 0.010 95);
--line:oklch(0.32 0.012 260);--line-2:oklch(0.40 0.013 260);
--accent:oklch(0.74 0.088 205);--accent-ink:oklch(0.80 0.086 205);
--accent-weak:oklch(0.31 0.040 218);--on-accent:oklch(0.17 0.012 260);
--pos:oklch(0.74 0.105 158);--pos-weak:oklch(0.31 0.050 158);
--neg:oklch(0.70 0.130 38);--neg-weak:oklch(0.31 0.060 38);
--ai:oklch(0.80 0.110 80);--ai-ink:oklch(0.85 0.100 82);
--ai-weak:oklch(0.31 0.048 78);--ai-line:oklch(0.46 0.070 78);
--focus:oklch(0.72 0.12 226);
--shadow-1:0 1px 2px oklch(0 0 0 / 0.30), 0 2px 8px oklch(0 0 0 / 0.28);
--shadow-2:0 2px 8px oklch(0 0 0 / 0.34), 0 16px 34px oklch(0 0 0 / 0.42)
}}

/* ---- Grund ---- */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:0 0 var(--p-rym-7);background:var(--yta);color:var(--text);
font-family:var(--p-sans);font-size:var(--brodtext);line-height:var(--p-rad-2);
font-weight:var(--p-vikt-1);accent-color:var(--accent);caret-color:var(--accent);
scrollbar-color:var(--linje) transparent}
::selection{background:var(--markering);color:var(--text)}
:focus-visible{outline:var(--fokus-tjocklek) solid var(--fokus);
outline-offset:var(--fokus-avstand)}
/* WCAG 2.4.11: fokus får inte hamna under den klistrade headern. */
:target,a,button,input,summary{scroll-margin-top:3.5rem}
.dold{position:absolute;width:var(--p-dold);height:var(--p-dold);overflow:hidden;
clip-path:inset(50%);white-space:nowrap}

/* ---- Hoppa till innehållet (WCAG 2.4.1) ---- */
.hoppa{position:fixed;top:0;left:0;z-index:var(--p-lager-hopp);
transform:translateY(var(--p-utanfor));
display:inline-flex;align-items:center;min-height:var(--p-traff);
padding:0 var(--p-rym-4);background:var(--accent);color:var(--accent-text);
font-weight:var(--p-vikt-2);text-decoration:none;
border-radius:0 0 var(--p-radie-1) 0}
.hoppa:focus{transform:none}

/* ---- Ram ---- */
header{position:sticky;top:0;z-index:var(--p-lager-header);background:var(--yta);
border-bottom:var(--p-linje-1) solid var(--linje);box-shadow:var(--skugga-lyft);
padding:var(--p-rym-1) var(--p-rym-4);display:flex;gap:var(--p-rym-4);
align-items:center;justify-content:space-between}
header nav{display:flex;gap:var(--p-rym-4);flex-wrap:wrap}
header nav a{display:inline-flex;align-items:center;min-height:var(--p-traff);
color:var(--accent);text-decoration:none;font-weight:var(--p-vikt-2)}
header nav a[aria-current]{color:var(--text);
box-shadow:inset 0 calc(var(--p-linje-2) * -1) 0 var(--accent)}
.tid{color:var(--text-svag);font-size:var(--meta);font-family:var(--mono);
font-variant-numeric:tabular-nums lining-nums}
main{max-width:var(--p-sida);margin:0 auto;padding:var(--p-rym-5) var(--p-rym-4) 0}
.fot{max-width:var(--p-sida);margin:var(--p-rym-7) auto 0;
padding:var(--p-rym-5) var(--p-rym-4) 0;border-top:var(--p-linje-1) solid var(--linje);
color:var(--text-svag);font-size:var(--meta);text-align:center;line-height:var(--p-rad-1)}

/* ---- Typografi: h1 > h2 > h3 > meta i storlek, vikt OCH färg ---- */
h1,h2,h3{text-wrap:balance;color:var(--text)}
h1{font-family:var(--display);font-size:var(--rubrik-1);font-weight:var(--p-vikt-3);line-height:var(--p-rad-tat);
letter-spacing:var(--p-spar-tat);margin:0 0 var(--p-rym-2)}
h2{font-family:var(--display);font-size:var(--rubrik-2);font-weight:var(--p-vikt-2);
line-height:var(--p-rad-tat);letter-spacing:0;margin:var(--p-rym-6) 0 var(--p-rym-3);
padding-top:var(--p-rym-4);border-top:var(--p-linje-1) solid var(--linje)}
h3{font-family:var(--display);font-size:var(--rubrik-3);font-weight:var(--p-vikt-3);line-height:var(--p-rad-1);
margin:var(--p-rym-5) 0 var(--p-rym-2)}
p{margin:0 0 var(--p-rym-4);max-width:var(--p-matt);text-wrap:pretty}
a{color:var(--accent);text-underline-offset:var(--p-understryk);
text-decoration-thickness:from-font}

/* ---- Kort och rader ---- */
.kort{display:block;min-height:var(--p-traff);background:var(--kort-yta);
border:var(--p-linje-1) solid var(--kort-linje);border-radius:var(--kort-radie);
box-shadow:var(--skugga-lyft);
padding:var(--kort-luft);margin:var(--kort-mellanrum) 0;
text-decoration:none;color:inherit}
.kort b{display:block;font-size:var(--brodtext);font-weight:var(--p-vikt-2);
line-height:var(--p-rad-1);color:var(--text)}
.kort .meta{display:block;margin-top:var(--p-rym-2);color:var(--text-svag);
font-size:var(--meta);line-height:var(--p-rad-1);font-variant-numeric:tabular-nums}
.rad{background:var(--kort-yta);border:var(--p-linje-1) solid var(--kort-linje);
border-radius:var(--kort-radie);box-shadow:var(--skugga-lyft);padding:var(--p-rym-3) var(--kort-luft);
margin:var(--kort-mellanrum) 0}
.rad .huvud{display:flex;gap:var(--p-rym-2);align-items:center;flex-wrap:wrap;
font-size:var(--meta);line-height:var(--p-rad-1);color:var(--text-svag);
font-variant-numeric:tabular-nums}
.rad .text{margin:var(--p-rym-2) 0 0;color:var(--text)}
ul.lista{list-style:none;padding:0;margin:0 0 var(--p-rym-4)}
.text{white-space:pre-wrap;overflow-wrap:anywhere;max-width:var(--p-matt);
text-wrap:pretty}
.summering{color:var(--text-svag);font-size:var(--meta);letter-spacing:normal;
font-weight:var(--p-vikt-1);font-variant-numeric:tabular-nums}
p.summering,p.notis{max-width:var(--p-matt)}
p.summering{margin:0 0 var(--p-rym-5)}
.notis{color:var(--text-svag);font-size:var(--meta);margin:0 0 var(--p-rym-4)}

/* ---- Proveniensmärket (KRAV-5): ikonen är dekor, texten bär betydelsen ---- */
.prov{display:inline-flex;align-items:center;gap:var(--p-rym-1);
border:var(--p-linje-1) solid;border-radius:var(--chip-radie);
padding:0 var(--p-rym-2);font-size:var(--meta);font-weight:var(--p-vikt-2);
line-height:var(--p-rad-2);white-space:nowrap}
.prov-agent{background:var(--prov-agent-yta);color:var(--prov-agent-text);
border-color:var(--prov-agent-linje)}
.prov-manniska{background:var(--prov-manniska-yta);color:var(--prov-manniska-text);
border-color:var(--prov-manniska-linje)}
.prov-system{background:var(--prov-system-yta);color:var(--prov-system-text);
border-color:var(--prov-system-linje)}
.prov-okand{background:var(--prov-okand-yta);color:var(--prov-okand-text);
border-color:var(--prov-okand-linje)}

/* ---- Etiketter och fasetter ---- */
.tagg{display:inline-block;border:var(--p-linje-1) solid var(--linje);
background:var(--kort-yta);border-radius:var(--chip-radie);
padding:0 var(--p-rym-2);font-size:var(--meta);color:var(--text-svag);
margin:0 var(--p-rym-1) var(--p-rym-1) 0}
.fasetter{margin:0 0 var(--p-rym-5)}
.fasetter .grupp{margin:0 0 var(--p-rym-4)}
.fasetter .grupp:last-child{margin-bottom:0}
.fasetter .namn{display:inline-block;margin-right:var(--p-rym-2);color:var(--text-svag);
font-size:var(--meta);font-weight:var(--p-vikt-2);text-transform:uppercase;
letter-spacing:var(--p-spar-vid)}
.chips{display:flex;flex-wrap:wrap;gap:var(--p-rym-2);margin-top:var(--p-rym-2)}
a.fasett{display:inline-flex;align-items:center;min-height:var(--chip-hojd);
padding:0 var(--chip-luft);border:var(--p-linje-1) solid var(--linje-2);
background:var(--kort-yta);border-radius:var(--chip-radie);
font-size:var(--brodtext);color:var(--text);text-decoration:none}
a.fasett.aktiv{background:var(--accent);color:var(--accent-text);
border-color:var(--accent);font-weight:var(--p-vikt-2)}

/* ---- Sökfältet ---- */
form.sok{display:flex;gap:var(--p-rym-2);flex-wrap:wrap;margin:0 0 var(--p-rym-5)}
input[type=search]{flex:1 1 var(--p-falt);min-height:var(--falt-hojd);appearance:none;
background:var(--kort-yta);color:var(--text);
border:var(--p-linje-1) solid var(--linje-2);border-radius:var(--falt-radie);
padding:0 var(--p-rym-3);font-family:inherit;font-size:var(--brodtext)}
input[type=search]::placeholder{color:var(--text-svag);opacity:1}
button,.btn{display:inline-flex;align-items:center;justify-content:center;
gap:var(--p-rym-1);min-height:var(--falt-hojd);background:var(--knapp-yta);
color:var(--knapp-text);border:var(--p-linje-1) solid var(--knapp-yta);
border-radius:var(--falt-radie);padding:0 var(--p-rym-5);font-family:inherit;
font-size:var(--brodtext);font-weight:var(--p-vikt-2);cursor:pointer;
text-decoration:none}
.btn--primary{background:var(--accent);color:var(--on-accent);border-color:transparent}
.btn--ghost{background:transparent;border-color:var(--line-2);color:var(--ink-2)}
.btn--sm{min-height:0;padding:6px 11px;font-size:var(--meta)}

/* ---- Renderat innehåll: dokumentsidan (.dok) och ärendetexten (.text) ---- */
.dok{overflow-wrap:anywhere}
/* Dokumentets första rubrik står redan under sidans h1 — ingen linje ovanför den. */
.dok>h2:first-child{margin-top:0;padding-top:0;border-top:0}
/* Ärendetexten ligger i ett kort: första och sista blocket bär ingen egen luft. */
.text>:first-child{margin-top:0}
.text>:last-child,.text blockquote>:last-child,.text li>:last-child{margin-bottom:0}
.dok p,.dok li,.text li{max-width:var(--p-matt)}
.dok ul,.dok ol,.text ul,.text ol{padding-left:var(--p-rym-5);margin:0 0 var(--p-rym-4)}
.dok li,.text li{margin:0 0 var(--p-rym-1)}
/* KRAV-8: innehållets rubriknivåer delar EN typstorlek. Typskalan har fyra, och
   en femte är förbjuden — så nivåerna skiljs åt med vikt, färg och versalisering
   i stället. Ingen av dem får heller bli lika stor som sidans egen h2: läsaren
   ska aldrig tro att en rubrik ur en kommentar är en rubrik i vyn.
   h3 behöver ingen egen regel — den globala h3 säger redan rätt sak.
   Versalerna sätts med text-transform, aldrig i strängen: skärmläsaren ska läsa
   ordet, inte bokstäverna. */
.dok h4,.text h4{font-size:var(--rubrik-3);font-weight:var(--p-vikt-2);
color:var(--text-svag);margin:var(--p-rym-5) 0 var(--p-rym-2)}
.text h5{font-size:var(--meta);font-weight:var(--p-vikt-2);color:var(--text-svag);
line-height:var(--p-rad-1);text-transform:uppercase;letter-spacing:var(--p-spar-vid);
margin:var(--p-rym-4) 0 var(--p-rym-1)}
.dok hr,.text hr{border:0;border-top:var(--p-linje-1) solid var(--linje)}
.dok hr{margin:var(--p-rym-6) 0}
.text hr{margin:var(--p-rym-5) 0}
/* Citatet är INNEHÅLL, inte metatext: full textfärg, aldrig --text-svag. Det är
   linjen som bär betydelsen — färg ensam räcker inte (WCAG 1.4.1). Den bär
   därför --linje-stark, inte husets hårfina avdelare: en avdelare som råkar
   vara det enda som skiljer citat från brödtext är för svag (WCAG 1.4.11). */
.text blockquote{margin:0 0 var(--p-rym-4);padding-left:var(--p-rym-3);
border-left:var(--p-linje-2) solid var(--linje-stark);color:var(--text)}
pre{background:var(--yta-sankt);border:var(--p-linje-1) solid var(--linje);
border-radius:var(--falt-radie);padding:var(--p-rym-3) var(--p-rym-4);
overflow-x:auto;font-family:var(--p-mono);font-size:var(--meta);
line-height:var(--p-rad-1)}
code{font-family:var(--p-mono);font-size:var(--meta);background:var(--yta-sankt);
border-radius:var(--p-radie-1);padding:0 var(--p-rym-1)}

/* ---- K-1: skrivytan. Formulär och knappar — inte en rad skript. ---- */
.hornet{display:flex;gap:var(--p-rym-3);align-items:center}
.jag{text-decoration:none}
.kvitto{color:var(--text);border-left:var(--p-linje-2) solid var(--accent);
padding-left:var(--p-rym-3)}
form.skrivform{margin:0 0 var(--p-rym-4)}
textarea{display:block;width:100%;max-width:var(--p-matt);appearance:none;
background:var(--kort-yta);color:var(--text);
border:var(--p-linje-1) solid var(--linje-2);border-radius:var(--falt-radie);
padding:var(--p-rym-3);font-family:inherit;font-size:var(--brodtext);
line-height:var(--p-rad-2);resize:vertical}
input[type=text],input[type=password]{flex:1 1 var(--p-falt);
min-height:var(--falt-hojd);appearance:none;background:var(--kort-yta);
color:var(--text);border:var(--p-linje-1) solid var(--linje-2);
border-radius:var(--falt-radie);padding:0 var(--p-rym-3);font-family:inherit;
font-size:var(--brodtext)}
label[for=nyckel]{display:block;font-size:var(--meta);color:var(--text-svag);
margin-bottom:var(--p-rym-1)}
.skrivrad{display:flex;gap:var(--p-rym-3);align-items:center;flex-wrap:wrap;
margin-top:var(--p-rym-2)}
.skrivrad .meta{color:var(--text-svag);font-size:var(--meta);
line-height:var(--p-rad-1)}
button.mild{background:var(--kort-yta);color:var(--text);
border:var(--p-linje-1) solid var(--linje-2);font-weight:var(--p-vikt-1)}
details.rattelse{margin:var(--p-rym-3) 0 0}
details.rattelse summary{display:flex;align-items:center;min-height:var(--p-traff);
cursor:pointer;color:var(--accent);font-size:var(--meta)}
.taggar{display:flex;flex-wrap:wrap;gap:var(--p-rym-1);margin:0 0 var(--p-rym-4)}
form.taggform{margin:0}
button.tagg{cursor:pointer;font-family:inherit;font-weight:var(--p-vikt-1)}
form.namnform{display:flex;gap:var(--p-rym-2);flex-wrap:wrap;align-items:center;
margin:0}

/* ---- Komponentgrammatiken ur kanon: chip, badge, factcard, tabell ----
   Namnen ar kanons, inte vyns egna. Det ar hela poangen: en chip ska heta
   chip i alla tre husen, annars ar likheten en slump och inte ett kontrakt. */
.chip{display:inline-flex;align-items:center;gap:var(--p-rym-1);
padding:2.5px 9px;border-radius:var(--chip-radie);
font-size:var(--meta);font-weight:550;line-height:1.5;
border:var(--p-linje-1) solid transparent;white-space:nowrap}
.chip__i{font-size:11px;line-height:1}
.chip--muted{background:var(--surface-2);color:var(--ink-2);border-color:var(--line)}
.chip--ok{background:var(--pos-weak);color:var(--pos);
border-color:color-mix(in oklch,var(--pos) 30%,transparent)}
.chip--info{background:var(--accent-weak);color:var(--accent-ink);
border-color:color-mix(in oklch,var(--accent) 28%,transparent)}
.chip--warn{background:var(--ai-weak);color:var(--ai-ink);border-color:var(--ai-line)}
.chip--neg{background:var(--neg-weak);color:var(--neg);
border-color:color-mix(in oklch,var(--neg) 30%,transparent)}
.chip--ai{background:var(--ai-weak);color:var(--ai-ink);border-color:var(--ai-line)}
.badge{display:inline-block;min-width:17px;padding:0 5px;margin-left:3px;
border-radius:9px;background:var(--accent);color:var(--on-accent);
font-size:11px;font-weight:700;text-align:center;line-height:17px}
.factcard{background:var(--surface);border:var(--p-linje-1) solid var(--line-2);
border-radius:var(--radius);padding:13px 15px;
display:flex;flex-direction:column;gap:9px}
.factcard__head{font-size:12px;font-weight:650;letter-spacing:.05em;
text-transform:uppercase;color:var(--ink-3)}
.eyebrow{display:inline-block;font-size:11.5px;font-weight:600;
letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
/* Tabellen kommer ur renderad markdown i dokumentvyn. Rubrikraden bar
   remsans familj, radlinjer i avdelarens ton, ingen zebra — som i kanon. */
.dok table,.text table{width:100%;border-collapse:collapse;display:block;
overflow-x:auto;font-size:13.5px;margin:0 0 var(--p-rym-4);
border:var(--p-linje-1) solid var(--line);border-radius:var(--radius);
background:var(--surface);box-shadow:var(--skugga-lyft)}
.dok th,.dok td,.text th,.text td{text-align:left;padding:11px 15px;
border-bottom:var(--p-linje-1) solid var(--line);vertical-align:top}
.dok th,.text th{background:var(--surface-2);color:var(--ink-2);
font-size:11.5px;font-weight:600;letter-spacing:.05em;
text-transform:uppercase;border-bottom:var(--p-linje-1) solid var(--line-2)}
.dok tbody tr:last-child td,.text tbody tr:last-child td{border-bottom:0}
/* Etiketten ar redan ett piller — den blir kanons dampade chip. */
.tagg{font-weight:550;line-height:1.5}

/* ---- Tillstånd. Hover bara med riktig pekare, rörelse bara om den tillåts. ---- */
@media(hover:hover){
.kort:hover{border-color:var(--accent)}
.kort:hover b{color:var(--accent)}
a.fasett:hover{border-color:var(--accent);color:var(--accent)}
a.fasett.aktiv:hover{color:var(--accent-text)}
}
@media(prefers-reduced-motion:no-preference){
a,button,.kort,.kort b,.hoppa{transition:color var(--p-tid-1) var(--p-kurva),
transform var(--p-tid-2) var(--p-kurva),opacity var(--p-tid-1) var(--p-kurva)}
.kort:active{transform:scale(var(--p-tryck-stor))}
button:active,a.fasett:active{transform:scale(var(--p-tryck))}
}
`;

/** Navigationen är samma ytor överallt — ordningen ändras aldrig (WCAG 3.2.3). */
export type Yta = 'vy' | 'digest' | 'sok' | 'rattelser' | 'mitt';

const YTOR: { vag: string; text: string; yta: Yta }[] = [
  { vag: '/vy', text: 'Ärenden', yta: 'vy' },
  { vag: '/vy/digest', text: 'Vad hände', yta: 'digest' },
  { vag: '/vy/sok', text: 'Sök', yta: 'sok' },
  // K-1. Lagd SIST: de tre befintliga ytorna byter aldrig plats.
  { vag: '/vy/rattelser', text: 'Rättelser', yta: 'rattelser' },
  // K-9. Samma regel: läggs sist, ingen befintlig yta flyttar (WCAG 3.2.3).
  { vag: '/vy/mitt', text: 'Vad ligger på mig', yta: 'mitt' },
];

/**
 * Sidramen. Navigationen är samma tre ytor överallt; klockslaget i hörnet är
 * ytor_servers detalj (den visar att sidan är färsk, inte cachad).
 *
 * `aktiv` märker den yta man står på med aria-current (KRAV-5). Sidor utanför
 * de tre ytorna — ärendet, dokumentet, 404 — lämnar den osatt.
 */
/**
 * K-1: `aktor` är TRE tillstånd, inte två.
 *   Aktor      — inloggad; märket visar vem skrivningar bokförs som.
 *   null       — utloggad på en sida där det går att logga in.
 *   undefined  — sidan vet inte (felsidor). Då står ingenting alls i hörnet:
 *                hellre tyst än ett påstående om inloggningsläget som kan vara
 *                fel.
 */
export function sida(
  titel: string,
  kropp: string,
  aktiv?: Yta,
  aktor?: Aktor | null,
): string {
  const nav = YTOR.map(
    (y) => `<a href="${y.vag}"${y.yta === aktiv ? ' aria-current=page' : ''}>${esc(y.text)}</a>`,
  ).join('');
  return (
    '<!doctype html><html lang=sv><head><meta charset=utf-8>' +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    '<meta name=apple-mobile-web-app-capable content=yes>' +
    `<title>${esc(titel)} — Ärenden</title><style>${CSS}</style></head><body>` +
    '<a class=hoppa href="#innehall">Hoppa till innehållet</a>' +
    `<header><nav aria-label="Vyns ytor">${nav}</nav>` +
    '<div class=hornet>' +
    (aktor === undefined
      ? ''
      : aktor === null
        ? '<a class=jag href="/vy/logga-in">Logga in</a>'
        : `<a class=jag href="/vy/logga-in">${proveniens(aktor.typ, aktor.namn)}</a>`) +
    `<span class=tid><span class=dold>Renderad </span>${esc(klockslag(new Date()))}</span>` +
    '</div></header>' +
    `<main id=innehall tabindex=-1>${kropp}</main>` +
    '<footer class=fot>Läsning kräver ingen nyckel. Ändringar kräver inloggning ' +
    'och lämnar alltid aktör och gammalt värde i händelseloggen.<br>' +
    'Ärendeplattformen är källan — inga länkar till Linear.</footer></body></html>'
  );
}

/**
 * Designkontraktet: status ar en CHIP, inte lopande text. Klassen kommer ur
 * state_typ (maskinvardet), ORDET ur state_namn — sa uppslaget aldrig kan
 * hitta pa ett tillstand som inte finns, och texten aldrig slutar vara den
 * arkivet faktiskt bar.
 *
 * Mappningen ar husets tre utfall: klart ar gront, avbrutet rott, pagaende
 * bar accenten, och det som annu inte borjat star dampat. Ett OKANT state_typ
 * far den dampade chippen och sitt namn utskrivet — aldrig en tom ruta.
 */
const STATE_CHIP: Record<string, string> = {
  completed: 'chip--ok',
  canceled: 'chip--neg',
  started: 'chip--info',
  unstarted: 'chip--muted',
  backlog: 'chip--muted',
};

export function statuschip(stateTyp: string, stateNamn: string): string {
  const klass = STATE_CHIP[stateTyp] ?? 'chip--muted';
  return `<span class="chip ${klass}">${esc(stateNamn)}</span>`;
}

// ---- Proveniens (KRAV-5, AI Act art. 50) ----------------------------------

// Ikonen är REDUNDANT dekor: den upprepar ordet bredvid och bärs därför
// aria-hidden (Designlyft KRAV-5). Tas den bort ur uppläsningen försvinner
// ingen information — ordet och namnet står kvar i klartext.
const MARKNING: Record<string, { ikon: string; ord: string; klass: string; titel: string }> = {
  agent: {
    ikon: '🤖',
    ord: 'agent',
    klass: 'prov-agent',
    titel: 'AI-genererat innehåll — skrivet av en agent (AI Act art. 50)',
  },
  manniska: {
    ikon: '👤',
    ord: 'människa',
    klass: 'prov-manniska',
    titel: 'Skrivet av en människa',
  },
  system: { ikon: '⚙️', ord: 'system', klass: 'prov-system', titel: 'Skrivet av en systemprocess' },
};

/**
 * Enda vägen att skriva ut en aktör. Både typen och namnet kommer ur databasens
 * kolumner; agentrader bär ALLTID "agent"-märkningen (AI Act art. 50) och en
 * okänd typ märks som okänd i stället för att smyga förbi omärkt.
 */
export function proveniens(aktorTyp: string, aktorNamn: string): string {
  const m = MARKNING[aktorTyp] ?? {
    ikon: '❓',
    ord: aktorTyp,
    klass: 'prov-okand',
    titel: 'Okänd aktörstyp',
  };
  return (
    `<span class="prov ${m.klass}" title="${esc(m.titel)}">` +
    `<span aria-hidden=true>${esc(m.ikon)}</span>` +
    `${esc(m.ord)} · ${esc(aktorNamn)}</span>`
  );
}

// ---- Formatering -----------------------------------------------------------

function tva(n: number): string {
  return String(n).padStart(2, '0');
}

/** Lokal tid, format som arkivet: 2026-08-13. Ingen locale-beroende utdata. */
export function datum(d: Date): string {
  return `${d.getFullYear()}-${tva(d.getMonth() + 1)}-${tva(d.getDate())}`;
}

export function klockslag(d: Date): string {
  return `${tva(d.getHours())}:${tva(d.getMinutes())}`;
}

export function datumtid(d: Date): string {
  return `${datum(d)} ${klockslag(d)}`;
}

// Linears skala: 1 = brådskande … 4 = låg.
const PRIO: Record<number, string> = { 1: 'Brådskande', 2: 'Hög', 3: 'Normal', 4: 'Låg' };

export function prioNamn(priority: number | null): string {
  return priority === null ? 'ingen prio' : (PRIO[priority] ?? `prio ${priority}`);
}

const VERB: Record<string, string> = {
  skapade_arende: 'skapade ärendet',
  importerade_arende: 'importerade ärendet',
  andrade_status: 'ändrade status',
  kommenterade: 'kommenterade',
  claimade_arende: 'plockade ärendet ur kön',
  tom_ko: 'fann kön tom',
  // K-2/K-3
  andrade_prioritet: 'ändrade prioritet',
  andrade_deadline: 'ändrade deadline',
  andrade_milstolpe: 'ändrade milstolpe',
  andrade_projekt: 'flyttade till projekt',
  andrade_foralder: 'ändrade förälder',
  arendet_oforandrat: 'lämnade ärendet oförändrat',
  lankade_arenden: 'länkade ärenden',
  lank_fanns_redan: 'länken fanns redan',
  lade_till_bilaga: 'lade till en dokumentlänk',
  bilagan_fanns_redan: 'dokumentlänken fanns redan',
  // K-1: rättningsvägarna.
  rattade_kommentar: 'rättade en kommentar',
  kommentaren_oforandrad: 'lämnade kommentaren oförändrad',
  tog_bort_kommentar: 'tog bort en kommentar',
  kommentaren_var_redan_borttagen: 'kommentaren var redan borttagen',
  aterstallde_kommentar: 'återställde en kommentar',
  kommentaren_var_inte_borttagen: 'kommentaren var inte borttagen',
  tog_bort_etikett: 'tog bort en etikett',
  etiketten_fanns_inte: 'etiketten fanns inte på ärendet',
  andrade_projektnamn: 'rättade projektnamnet',
  andrade_etikettnamn: 'rättade etikettnamnet',
  namnet_oforandrat: 'lämnade namnet oförändrat',
  aterkallade_nyckel: 'återkallade en nyckel',
  nyckeln_var_redan_aterkallad: 'nyckeln var redan återkallad',
  skapade_aktorsidentitet: 'utfärdade en aktörsidentitet',
};

export function verbText(verb: string): string {
  return VERB[verb] ?? verb.replace(/_/g, ' ');
}

// ---- K-3: bilagor och relationer -------------------------------------------

/**
 * Andra försvarslinjen mot ett farligt schema i en bilagas adress
 * (HttpUrlSchema är den första, vid skrivningen). Returnerar null för allt som
 * inte är absolut http/https — då renderas titeln som ren text i stället för
 * som en länk. En `javascript:`-URL i ett href är körbar kod i Davids
 * webbläsare, och att bara kontrollera den vid skrivningen vore att lita på att
 * ingen rad någonsin kommit in någon annan väg.
 */
export function sakerUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

/**
 * Relationens innebörd SEDD FRÅN det ärende sidan visar. 'blocks' är riktad, så
 * samma rad betyder olika saker i de två ändarna; 'related' är symmetrisk och
 * betyder detsamma i båda.
 */
export function relationText(typ: string, riktning: 'fran' | 'till'): string {
  if (typ === 'blocks') return riktning === 'fran' ? 'blockerar' : 'blockeras av';
  if (typ === 'related') return 'relaterat till';
  return typ;
}
