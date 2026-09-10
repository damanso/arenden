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
import { modell, type Post } from './navigation.js';

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
/* ---- Menygrammatiken (iteration 2). Kanons namn: appbar + nav. ----
   Egen kopia, som allt annat i kontraktet: samma grammatik som Hermes-ytan
   bar, men vyns egna mattoken. K-9 star — ingen delad fil, ingen delad rutt. */
.topbar{position:sticky;top:0;z-index:var(--p-lager-header);
background:var(--yta);box-shadow:var(--skugga-lyft)}
.appbar{display:flex;align-items:center;gap:var(--p-rym-3);
padding:var(--p-rym-2) var(--p-rym-4);
border-bottom:var(--p-linje-1) solid var(--linje)}
.appbar .brand{display:inline-flex;align-items:center;gap:var(--p-rym-2);
flex:none;font-family:var(--display);font-size:var(--meta);
font-weight:var(--p-vikt-2);letter-spacing:var(--p-spar-tat);
color:var(--text);text-decoration:none}
.appbar .brand:hover{color:var(--accent)}
.appbar .brand .mark{color:var(--accent);display:inline-flex}
.appbar .vart{color:var(--text-svag);font-size:var(--meta);min-width:0;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.appbar .vart::before{content:"/";color:var(--linje);margin-right:var(--p-rym-2)}
.appbar .hornet{margin-left:auto;flex:none}
/* Vagrat rullande rad utan radbrytning: fem piller ar bredare an en telefon,
   och en meny som bryter till tva rader flyttar sig nar innehallet byts.
   Rullningen ar CSS — vyn ar fortfarande utan en rad skript. */
header nav.nav{display:flex;gap:var(--p-rym-2);align-items:center;flex-wrap:nowrap;
padding:var(--p-rym-1) var(--p-rym-4);
border-bottom:var(--p-linje-1) solid var(--linje);
overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none}
header nav.nav::-webkit-scrollbar{display:none}
header nav.nav a{display:inline-flex;align-items:center;gap:var(--p-rym-2);
flex:none;min-height:var(--p-traff);padding:0 var(--p-rym-3);
border-radius:var(--p-radie-rund);border:var(--p-linje-1) solid transparent;
color:var(--text-svag);font-size:var(--meta);font-weight:var(--p-vikt-2);
text-decoration:none;white-space:nowrap;box-shadow:none}
header nav.nav a:hover{background:var(--yta-sankt);border-color:var(--linje);
color:var(--text)}
header nav.nav a[aria-current]{background:var(--accent-weak);
color:var(--accent-ink);border-color:color-mix(in oklch,var(--accent) 28%,transparent);
box-shadow:none}
header nav.nav.undernav{border-top:1px solid var(--linje);padding-top:var(--p-rym-2);
  margin-top:var(--p-rym-2)}
header nav.nav.undernav a{font-size:var(--meta)}
header nav.nav .ikon{opacity:.75}
header nav.nav a[aria-current] .ikon{opacity:1}
/* Brodsmulan star FORE rubriken och ar tyst: en position, inte en handling.
   Sista ledet ar aldrig en lank — man star redan dar. */
/* Produktmenyn. Kopierad EN gang ur redovisningens stilmall 2026-09-10.
   K-9: medveten dubblering, bevakad av prov, aldrig en delad fil. */
.navmenu { position: relative; flex: none; }
.navmenu > summary {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 12px 7px 10px; border-radius: var(--radius-pill);
  border: 1px solid var(--line-2); background: var(--surface);
  color: var(--ink); font-size: 13.5px; font-weight: 550;
  cursor: pointer; list-style: none; user-select: none;
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
}
.navmenu > summary::-webkit-details-marker { display: none; }
.navmenu > summary:hover { border-color: var(--accent); box-shadow: var(--shadow-1); }
.navmenu__ico--close, .navmenu[open] .navmenu__ico { display: none; }
.navmenu[open] .navmenu__ico--close { display: inline; }
.navmenu[open] > summary { background: var(--accent-weak); border-color: var(--accent); color: var(--accent-ink); }

/* Panelen: flytande kort som reser sig mjukt. */
.navmenu__panel {
  position: absolute; top: calc(100% + 9px); left: 0; z-index: 40;
  /* 48px headroom: 100vw inkluderar en ev. klassisk rullist (~17px på
     Windows/Linux) — med bara 24px spiller panelens högerkant utanför
     clientWidth och skapar en vågrät rullist så fort menyn öppnas. */
  width: min(880px, calc(100vw - 48px));
  padding: 16px 18px 18px;
  background: color-mix(in oklch, var(--surface) 97%, transparent);
  /* Ingen backdrop-filter har. Bakgrunden ar 97 % ogenomskinlig, sa ett filter
     kan bara verka pa de 3 % som lyser igenom.
     MATT i Chrome 2026-08-25 pa en identisk panel med och utan filtret, pixel
     for pixel: hogst 7 av 255 nivaers skillnad over hela ytan, och 210 449 av
     558 000 pixlar skilde exakt 4 nivaer - det ar de tre procenten. Undantaget
     ar fem pixlar i det rundade hornet, dar filtret klipper sin egen kant.
     KONTROLL med samma rigg vid 50 % opacitet: 102 av 255 och varenda pixel
     andrad. Riggen ser en oskarpa nar det finns en att se, sa nollan ovan ar
     ett svar och inte en trasig matning. */
  border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  max-height: min(72vh, 640px); overflow-y: auto; overscroll-behavior: contain;
}
@keyframes navrise { from { opacity: 0; transform: translateY(-6px) scale(.985); } to { opacity: 1; transform: none; } }
.navmenu[open] .navmenu__panel { animation: navrise .17s cubic-bezier(.2,.7,.3,1) both; }
/* Kolumnflöde (inte grid): grupperna packas tätt utan döda rader när de är
   olika höga, och antalet kolumner följer bredden av sig självt. */
.navmenu__grid { columns: 196px 4; column-gap: 26px; }
.navmenu__grp { break-inside: avoid; margin: 0 0 17px; }
.navmenu__grp > .eyebrow { display: block; margin-bottom: 1px; }
.navmenu__hint { display: block; font-size: 11.5px; color: var(--ink-3); margin-bottom: 7px; }
.navmenu__link {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 9px; border-radius: var(--radius-sm);
  color: var(--ink-2); font-size: 13.5px; font-weight: 500;
}
.navmenu__link:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
.navmenu__link.is-active { background: var(--accent-weak); color: var(--accent-ink); font-weight: 600; }
.navmenu__link.is-active::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex: none;
}
.navmenu__link:not(.is-active)::before { content: ""; width: 5px; flex: none; }

/* Snabbrad */
.nav__quick { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.nav__quick::-webkit-scrollbar { display: none; }
.nav__quick a {
  padding: 7px 11px; border-radius: var(--radius-pill);
  color: var(--ink-2); font-size: 13.5px; font-weight: 500; white-space: nowrap;
}
.nav__quick a:hover, .nav__grannar a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
/* Grannmodulerna: vägen UT ur redovisningen, inte en sida inom den.
   Samma form som snabbraden, egen behållare — spärrhaken i
   navigation.test.ts räknar snabbradens länkar och ska fortsätta göra det. */
.nav__grannar { display: flex; align-items: center; gap: 2px; min-width: 0; }
.nav__grannar a {
  padding: 7px 11px; border-radius: var(--radius-pill);
  color: var(--ink-2); font-size: 13.5px; font-weight: 500; white-space: nowrap;
  opacity: .85;
}
.nav__quick a.active { background: var(--accent-weak); color: var(--accent-ink); font-weight: 600; }

/* Undermeny (designkontraktets menygrammatik, "en nivå ner").
 *
 * Samma grammatik som snabbraden — en vågrätt rullande rad, aldrig radbrytning,
 * aria-current="page" på exakt EN post (WCAG 2.4.8) — men i FYRKANTIG form.
 * Formskillnaden säger "en nivå ner" utan ett ord, och sidan slipper därmed en
 * andra huvudmeny som konkurrerar med den riktiga.
 *
 * Läget bärs av aria-current, inte av färgen: strecket under den aktuella
 * posten är den andra ledtråden, och den syns i svartvitt och i högkontrastläge.
 * Helt JS-fritt — rullningen är CSS, precis som i .nav__quick. */
.subnav {
  display: flex; align-items: stretch; gap: 2px;
  min-width: 0; overflow-x: auto; scrollbar-width: none;
  margin: 6px 0 16px; border-bottom: 1px solid var(--line);
}
.subnav::-webkit-scrollbar { display: none; }
.subnav a {
  padding: 8px 11px; margin-bottom: -1px;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border-bottom: 2px solid transparent;
  color: var(--ink-2); font-size: 13px; font-weight: 500; white-space: nowrap;
}
.subnav a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }
.subnav a[aria-current="page"] {
  background: var(--accent-weak); color: var(--accent-ink);
  border-bottom-color: var(--accent); font-weight: 600;
}

/* "Du är här" — visas när sidan inte finns i snabbraden. */
.nav__here {
  display: inline-flex; align-items: baseline; gap: 7px;
  /* Får KRYMPA (inte flex:none): på telefonbredd kan grupp + sidnamn vara
     bredare än raden ("Kunder & leverantörer · Leverantörsreskontra") och
     spillde då hela sidan i sidled. Nu ellipsas sidnamnet i stället. */
  flex: 0 1 auto; min-width: 0; overflow: hidden;
  padding: 6px 12px; border-radius: var(--radius-pill);
  background: var(--accent-weak); color: var(--accent-ink);
  font-size: 13.5px; font-weight: 600; white-space: nowrap;
}
.nav__here .nav__here-grp { font-size: 11.5px; font-weight: 500; opacity: .75; flex: none; }
.nav__here .nav__here-lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nav__sep { width: 1px; height: 20px; background: var(--line); flex: none; }
.navmenu__grid{columns:196px 3}
.nav__omrade{font-weight:600;font-size:13px;color:var(--ink);padding:5px 4px;white-space:nowrap;flex:none;text-decoration:none}
a.nav__omrade:hover{text-decoration:underline}
.navmenu__grpl{display:block;margin-bottom:1px;text-decoration:none}
.navmenu__grpl:hover{text-decoration:underline}

.smula{display:flex;align-items:center;gap:var(--p-rym-2);flex-wrap:wrap;
margin:0 0 var(--p-rym-3);font-size:var(--meta);color:var(--text-svag)}
.smula a{color:var(--text-svag);text-decoration:none}
.smula a:hover{color:var(--accent);text-decoration:underline}
.smula .sep{color:var(--linje)}
.smula b{color:var(--text);font-weight:var(--p-vikt-2)}
/* Ikonspraket: ETT sprak. Samma rutnat, samma streckbredd, currentColor — sa
   ikonen arver textens farg i bada lagen. Dekor, aldrig betydelse. */
.ikon{display:inline-block;vertical-align:-.18em;flex:none}
/* Tomt lage: en mening som sager vad tomheten BETYDER, och en vag vidare.
   Ett raknat noll ar ett databassvar, inte ett besked till en manniska —
   och exemplet star med flit INTE utskrivet har: den har kommentaren
   skickas med varje sida, och en citerad strang blir en forekomst. */
.tomt{display:block;padding:var(--p-rym-5) var(--p-rym-4);
background:var(--kort-yta);border:var(--p-linje-1) dashed var(--linje);
border-radius:var(--kort-radie);color:var(--text-svag);
font-size:var(--brodtext);line-height:var(--p-rad-2);
margin:0 0 var(--p-rym-4);max-width:var(--p-matt)}
.tomt b{display:block;color:var(--text);font-weight:var(--p-vikt-2);
margin-bottom:var(--p-rym-1)}
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

// ---- Ikonspraket (iteration 2) --------------------------------------------
//
// ETT sprak: samma rutnat (20x20), samma streckbredd, currentColor. Ikonen
// arver textens farg i bada lagen och i varje tillstand, och ritas av oss —
// inget bibliotek, ingen CDN, ingen extern hamtning. Egen kopia per system,
// som allt annat i kontraktet.
//
// Emojin var problemet. Den ritas av OPERATIVSYSTEMET: olika teckensnitt och
// olika farger pa varje plattform, ingen av dem husets. En rad emoji i en meny
// ar det tydligaste tecknet pa att ett granssnitt inte ar ritat utan hopplockat.
//
// Ikonerna ar DEKOR och bar aria-hidden: ordet bredvid bar hela betydelsen.
// Samma regel som proveniensmarkets ikon redan foljer (KRAV-5).
const IKONER: Record<string, string> = {
  meny: 'M3 6h14|M3 10h14|M3 14h14',
  mal: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z|M13.4 10a3.4 3.4 0 1 1-6.8 0 3.4 3.4 0 0 1 6.8 0z|M10.4 10h-.8',
  relation: 'M8.6 6.6a3 3 0 1 1-4.2 4.2M11.4 13.4a3 3 0 1 1 4.2-4.2|M7.8 12.2l4.4-4.4',
  // Huvudmenyns ikoner, ordagrant ur Hermes-ytornas IKONER: samma val ska
  // se likadant ut i alla tre modulerna (Astras UX-granskning 2026-09-09).
  oversikt: 'M3.4 9.1 10 3.7l6.6 5.4v6.6a.9.9 0 0 1-.9.9h-3.5v-4.4H7.8v4.4H4.3a.9.9 0 0 1-.9-.9z',
  rum: 'M5.8 3.4h8.4v13.2H5.8z|M12 10.1h.01',
  bibliotek: 'M4.2 5A1.6 1.6 0 0 1 5.8 3.4h10v13.2h-10A1.6 1.6 0 0 1 4.2 15z|M4.2 13.8h11.6',
  redovisning: 'M4.8 3.3h10.4v13.4H4.8z|M7.6 7.1h4.8M7.6 10h4.8M7.6 12.9h2.9',
  personer: 'M8 9.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z|M3.4 16.4c0-2.6 2.1-4.4 4.6-4.4s4.6 1.8 4.6 4.4|M13.4 5.1a2.4 2.4 0 0 1 0 4.6M14.4 12.3c1.4.5 2.2 1.9 2.2 3.4',
  marke:
    'M10 2.6 17 6.4v7.2L10 17.4 3 13.6V6.4z|M10 7.2v5.6M7.6 8.5v3M12.4 8.5v3',
  mitt:
    'M12.6 7.4a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z|M4.4 16.6c0-2.9 2.5-5 5.6-5s5.6 2.1 5.6 5',
  arenden:
    'M3.2 5.9h13.6v8.2H3.2z|m3.4 6.4 6.6 4.4 6.6-4.4',
  flode:
    'M2.8 10h3.1l1.9-4.4 3.9 8.8 1.9-4.4h3.6',
  sok:
    'M15.4 9.1a6.3 6.3 0 1 1-12.6 0 6.3 6.3 0 0 1 12.6 0z|m13.7 13.7 3.5 3.5',
  rattelse:
    'M13.4 3.6 16.4 6.6 7.4 15.6 3.6 16.4l.8-3.8z|M11.6 5.4l3 3',
  dokument:
    'M6.1 3.3h5.5l3.3 3.3v10.1H6.1z|M11.4 3.4v3.4h3.4|M8.2 11h5M8.2 13.6h3.4',
  extern:
    'M8.1 4.6h7.3v7.3M15.4 4.6 5.6 14.4',
  klar:
    'M17.2 10a7.2 7.2 0 1 1-14.4 0 7.2 7.2 0 0 1 14.4 0z|m6.9 10.1 2.2 2.2 4.1-4.5',
  tid:
    'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0z|M10 5.9V10l2.6 1.8',
};

/** En ikon, eller tom strang. En SAKNAD ikon far aldrig valta en sida. */
export function ikon(namn: string, storlek = 16): string {
  const d = IKONER[namn];
  if (!d) return '';
  const paths = d.split('|').map((p) => '<path d="' + p + '"/>').join('');
  return (
    '<svg class=ikon width=' + storlek + ' height=' + storlek +
    ' viewBox="0 0 20 20" fill=none stroke=currentColor stroke-width=1.5' +
    ' stroke-linecap=round stroke-linejoin=round aria-hidden=true' +
    ' focusable=false>' + paths + '</svg>'
  );
}

/**
 * Brodsmulan: var man ar. Sista ledet ar ALDRIG en lank — man star redan dar.
 * Delarna ar [text, vag|null]; texten escapas, vagen ar husets egen.
 */
export function brodsmula(delar: [string, string | null][]): string {
  const led = delar.map(([text, vag], i) => {
    const sep = i ? '<span class=sep>\u203a</span>' : '';
    const sist = i === delar.length - 1;
    return sep + (vag && !sist
      ? '<a href="' + vag + '">' + esc(text) + '</a>'
      : '<b>' + esc(text) + '</b>');
  });
  return '<nav class=smula aria-label="Var du är">' + led.join('') + '</nav>';
}

/**
 * Ett tomt lage sager vad tomheten BETYDER och pekar vidare. "Inga träffar."
 * ar ett databassvar; en manniska som moter det vet inte om hon sokt fel,
 * om det saknas data eller om allt ar gjort.
 */
export function tomtLage(rubrik: string, mening: string,
                         vag?: string, lanktext?: string): string {
  const vidare = vag && lanktext
    ? ' <a href="' + vag + '">' + esc(lanktext) + '</a>'
    : '';
  return '<div class=tomt><b>' + esc(rubrik) + '</b>' + esc(mening) + vidare + '</div>';
}

/**
 * Navigationen är samma ytor överallt, i samma ordning på varje sida — det är
 * det WCAG 3.2.3 kräver, och det håller.
 *
 * ORDNINGEN ÄR OMLAGD EN GÅNG, MED AVSIKT (designtråden 31/8). Husregeln hit
 * har varit "nya ytor läggs sist, befintliga flyttar aldrig", och den regeln
 * skrevs för TILLÄGG — den ska fortsätta gälla för nästa yta som tillkommer.
 * Det här är inte ett tillägg utan en omläggning av hela raden: "vad ligger på
 * mig" är det man kommer hit för, och den låg sist för att den byggdes sist.
 * Att låta byggordningen bestämma läsordningen är precis den sortens sak som
 * får ett gränssnitt att kännas hopsamlat i stället för ritat.
 *
 * Namnen i menyn är den kortaste formen av sidans eget namn; sidans h1 står
 * kvar oförändrad. "Mitt" i menyn, "Vad ligger på mig" som rubrik.
 */
export type Yta = 'vy' | 'digest' | 'sok' | 'rattelser' | 'mitt';

/**
 * HUVUDVALEN. Samma fem, i samma ordning, i alla tre kodbaserna (Astras
 * UX-granskning 2026-09-09, avsnitt 3 och 5). De är rotrelativa: sedan
 * modulerna monterats bakom samma värd är /vy och /app grannar i SAMMA
 * miljö, inte andra system.
 *
 * Före det här stod tre egna menyer med en "grannar"-sektion sist. Koden här
 * beskrev själv varför de fanns: utan dem måste David skriva adressen för
 * hand. Svaret var rätt problem och fel lösning — en gäst i menyn är fortfarande
 * en gäst. David sade det rakt ut: "jag upplever att jag är i 4 olika miljöer".
 */
// HÄRLEDS UR KONTRAKTET (Astras steg 5). Listan stod här som sju handskrivna
// rader, identiska med två andra listor i två andra kodbaser — tills någon
// rörde en av dem, och ingenting mätte att de fortfarande var det. Nu läser
// varje kodbas sin EGNA kopia av navigation.v1.json och räknar fram samma
// modell; prov/adresskontraktet.py jämför de tre mot ett referenskontrakt som
// räknas fram oberoende av dem.
//
// Ikonerna ligger kvar HÄR med flit: de är lokal presentation, inte identitet
// eller adress, och kontraktet äger det senare.
const MENYIKONER: Record<string, string> = {
  home: 'oversikt',
  intervention: 'beslut',
  accounting_entry: 'redovisning',
  projects_entry: 'mal',
  crm_entry: 'relation',
  cases_all: 'arenden',
  library: 'bibliotek',
};

export const HUVUDVAL: { vag: string; text: string; ikonnamn: string; id: string }[] =
  modell().global.map((p) => ({
    vag: p.href ?? '/',
    text: p.label,
    ikonnamn: MENYIKONER[p.id] ?? 'oversikt',
    id: p.id,
  }));

/** Modulens egna ytor. Undermeny — den ersätter aldrig huvudmenyn. */
const YTOR: { vag: string; text: string; yta: Yta; ikonnamn: string }[] = [
  { vag: '/vy/mitt', text: 'Mitt', yta: 'mitt', ikonnamn: 'mitt' },
  { vag: '/vy', text: 'Alla', yta: 'vy', ikonnamn: 'arenden' },
  { vag: '/vy/digest', text: 'Vad hände', yta: 'digest', ikonnamn: 'flode' },
  { vag: '/vy/sok', text: 'Sök', yta: 'sok', ikonnamn: 'sok' },
  { vag: '/vy/rattelser', text: 'Rättelser', yta: 'rattelser', ikonnamn: 'rattelse' },
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
// Adresserna byts på ETT ställe när ingången flyttar modulerna till vägar.
// GRANNAR ar borttagen 2026-09-09. Den bar tva absoluta lankar till andra
// portar och gjorde de andra modulerna till gaster i den har menyn. Sedan
// modulerna monterats bakom samma vard star de i HUVUDVAL i stallet -- som
// delar av samma miljo, inte som utflykter. prov/enmiljo.py haller det.


/**
 * Produktmenyn: menyknappen, omradet man star i, och omradets sidor.
 *
 * Harledd ur den har kodbasens EGNA kopia av navigation.v1.json. Gruppens
 * rubrik ar vagen till omradets ingang — sedan huvudraden togs bort finns
 * ingen annan vag dit, och utan den hade Hem och Bibliotek blivit omojliga
 * att na.
 */
function produktmeny(aktivVag: string | null): string {
  const m = modell();
  let grupp: (typeof m.groups)[number] | null = null;
  let post: Post | null = null;
  for (const g of m.groups) {
    for (const p of g.items) {
      if (p.href === aktivVag) {
        grupp = g;
        post = p;
      }
    }
  }
  if (!grupp) {
    for (const g of m.groups) {
      if (g.entry?.href && g.entry.href === aktivVag) grupp = g;
    }
  }

  const rubrik = (g: (typeof m.groups)[number]): string =>
    g.entry?.href
      ? `<a class="eyebrow navmenu__grpl" href="${g.entry.href}" data-destination-id="${esc(g.entry.id)}">${esc(g.label)}</a>`
      : `<span class=eyebrow>${esc(g.label)}</span>`;

  const grupper = m.groups
    .map(
      (g) =>
        `<div class=navmenu__grp>${rubrik(g)}` +
        `<span class=navmenu__hint>${esc(g.hint)}</span>` +
        g.items
          .map((p) => {
            const pa = post !== null && p.id === post.id;
            return (
              `<a class="navmenu__link${pa ? ' is-active' : ''}" href="${p.href ?? '#'}"` +
              `${pa ? ' aria-current=page' : ''} data-destination-id="${esc(p.id)}">${esc(p.label)}</a>`
            );
          })
          .join('') +
        '</div>',
    )
    .join('');

  const snabb: Post[] = grupp
    ? grupp.id === 'accounting'
      ? m.quick
      : grupp.items.slice(0, 6)
    : [];

  const omradet = grupp
    ? grupp.entry?.href
      ? `<a class=nav__omrade href="${grupp.entry.href}" data-destination-id="${esc(grupp.entry.id)}">${esc(grupp.label)}</a>`
      : `<span class=nav__omrade>${esc(grupp.label)}</span>`
    : '';

  const kvick = snabb
    .map((p) => {
      const pa = post !== null && p.id === post.id;
      return (
        `<a${pa ? ' class=active' : ''} href="${p.href ?? '#'}"` +
        `${pa ? ' aria-current=page' : ''} data-destination-id="${esc(p.id)}">${esc(p.label)}</a>`
      );
    })
    .join('');

  const har =
    post !== null && !snabb.some((p) => p.id === post!.id)
      ? `<span class=nav__here><span class=nav__here-grp>${esc(grupp!.label)}</span>` +
        `<span class=nav__here-lbl>${esc(post.label)}</span></span>`
      : '';

  return (
    '<nav class=nav aria-label="Huvudmeny">' +
    `<details class=navmenu><summary>${ikon('meny')}<span>Meny</span></summary>` +
    `<div class=navmenu__panel><div class=navmenu__grid>${grupper}</div></div></details>` +
    `<span class=nav__sep></span>${omradet}<div class=nav__quick>${kvick}</div>${har}</nav>`
  );
}

export function sida(
  titel: string,
  kropp: string,
  aktiv?: Yta,
  aktor?: Aktor | null,
  smula?: [string, string | null][],
): string {
  // Huvudmenyn är hela miljöns karta och ser likadan ut i alla moduler.
  // Arbete är det aktiva valet så länge man är i den här modulen.
  // EN rad: menyknappen, vilken del man star i, och den delens sidor.
  // Huvudraden och modulens egen undermeny togs bort 2026-09-10 pa Davids
  // besked: "allt ska ga att na via menyn". Bada var kartor bredvid en karta.
  const nav = produktmeny(YTOR.find((y) => y.yta === aktiv)?.vag ?? null);
  return (
    '<!doctype html><html lang=sv><head><meta charset=utf-8>' +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    '<meta name=apple-mobile-web-app-capable content=yes>' +
    `<title>${esc(titel)} — Hermes</title><style>${CSS}</style></head><body>` +
    '<a class=hoppa href="#innehall">Hoppa till innehållet</a>' +
    '<header class=topbar><div class=appbar>' +
    `<a class=brand href="/"><span class=mark>${ikon('marke', 18)}</span>` +
    'Hermes</a>' +
    `<span class=vart>${esc(titel)}</span>` +
    '<div class=hornet>' +
    (aktor === undefined
      ? ''
      : aktor === null
        ? '<a class=jag href="/vy/logga-in">Logga in</a>'
        : `<a class=jag href="/vy/logga-in">${proveniens(aktor.typ, aktor.namn)}</a>`) +
    `<span class=tid><span class=dold>Renderad </span>${esc(klockslag(new Date()))}</span>` +
    '</div></div>' +
    `${nav}</header>` +
    `<main id=innehall tabindex=-1>${smula ? brodsmula(smula) : ''}${kropp}</main>` +
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
