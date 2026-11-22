import React from 'react';

// Santi: personaje aprobado (estilo póster de viaje, proporciones adultas, sin contornos).
// Portado de personaje/santi.html para animarlo: cada cuadro recibe la pose y la expresión.
// Los pies quedan en y = 0; la cabeza llega a y ≈ -600.

const C = {
  piel: '#E6B892', pielSombra: '#C99673', pelo: '#3B2A21', cejas: '#33241C',
  buzo: '#F2F0EB', buzoSombra: '#D9D5CC', pantalon: '#4B4A50', pantalonSombra: '#3C3B40',
  tenis: '#D7DADF', suela: '#F7F7F7', reloj: '#B9BEC5', mochila: '#B5553C', mochilaSombra: '#93432F',
  boca: '#7C3B32', ojo: '#2A1D17',
};

type Cara = {cejaI?: number[]; cejaD?: number[]; ojos?: string; boca?: string; mirada?: number};
export const EXPR: Record<string, Cara> = {
  neutral: {boca: 'neutra'},
  sonrisa: {boca: 'sonrisa', cejaI: [-4, -1], cejaD: [-4, -1]},
  sorpresa: {boca: 'abierta', ojos: 'abiertos', cejaI: [-8, -6], cejaD: [-8, -6]},
  duda: {boca: 'lado', cejaI: [8, 2], cejaD: [-14, -5], mirada: 1.5},
  pensando: {boca: 'o', cejaI: [4, 0], cejaD: [-6, -3], mirada: 2},
  risa: {boca: 'risa', ojos: 'cerrados', cejaI: [-6, -3], cejaD: [-6, -3]},
  ojo: {boca: 'preocupada', cejaI: [-12, -2], cejaD: [-12, -2]},
};
export type Expresion = keyof typeof EXPR;

function cara(e: Cara): string {
  const E = {cejaI: [0, 0], cejaD: [0, 0], ojos: 'normal', boca: 'neutra', mirada: 0, ...e};
  let s = '';
  s += `<ellipse cx="-34" cy="2" rx="6" ry="10" fill="${C.piel}"/><ellipse cx="34" cy="2" rx="6" ry="10" fill="${C.pielSombra}"/>`;
  s += `<path d="M-33 -8 Q-34 -44 0 -44 Q34 -44 33 -8 Q33 26 18 38 Q8 45 0 45 Q-8 45 -18 38 Q-33 26 -33 -8 Z" fill="${C.piel}"/>`;
  s += `<path d="M6 -44 Q34 -44 33 -8 Q33 26 18 38 Q12 43 6 44 Q16 20 14 -10 Q12 -34 6 -44 Z" fill="${C.pielSombra}" opacity="0.55"/>`;
  s += `<path d="M-30 12 Q-26 34 -14 41 Q0 48 14 41 Q26 34 30 12 Q20 26 0 27 Q-20 26 -30 12 Z" fill="${C.pelo}" opacity="0.13"/>`;
  s += `<path d="M-34 -4 Q-37 -30 -26 -44 Q-10 -58 10 -55 Q30 -52 35 -34 Q37 -20 34 -4 Q31 -18 28 -27 Q12 -33 -6 -33 Q-22 -32 -29 -22 Q-32 -14 -34 -4 Z" fill="${C.pelo}"/>`;
  s += `<path d="M-14 -52 Q-8 -42 -6 -33" stroke="#5a4335" stroke-width="2" fill="none" opacity="0.7"/>`;
  const ex = 13, ey = -3, m = E.mirada;
  if (E.ojos === 'cerrados') {
    for (const sx of [-1, 1])
      s += `<path d="M${sx * ex - 6} ${ey} Q${sx * ex} ${ey + 4} ${sx * ex + 6} ${ey}" stroke="${C.ojo}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  } else {
    const ry = E.ojos === 'abiertos' ? 5.2 : 3.6;
    const rx = E.ojos === 'abiertos' ? 4.4 : 3.8;
    for (const sx of [-1, 1]) {
      if (E.ojos === 'abiertos') s += `<ellipse cx="${sx * ex}" cy="${ey}" rx="${rx + 2.4}" ry="${ry + 1.8}" fill="#fff"/>`;
      s += `<ellipse cx="${sx * ex + m}" cy="${ey}" rx="${rx}" ry="${ry}" fill="${C.ojo}"/>`;
    }
  }
  const ceja = (sx: number, [ang, dy]: number[]) =>
    `<g transform="translate(${sx * 13} ${-14 + dy}) rotate(${sx * ang})"><path d="M-9 1 Q0 -3 9 0 L9 3 Q0 0 -9 4 Z" fill="${C.cejas}"/></g>`;
  s += ceja(-1, E.cejaI) + ceja(1, E.cejaD);
  s += `<path d="M1 0 Q4 10 6 14 Q3 17 -2 16" stroke="${C.pielSombra}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  const by = 27;
  const B: Record<string, string> = {
    neutra: `<path d="M-8 ${by} Q0 ${by + 1.5} 8 ${by}" stroke="${C.boca}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`,
    sonrisa: `<path d="M-11 ${by - 2} Q0 ${by + 7} 11 ${by - 2}" stroke="${C.boca}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`,
    risa: `<path d="M-12 ${by - 3} Q0 ${by + 11} 12 ${by - 3} Z" fill="${C.boca}"/><path d="M-9 ${by - 2} Q0 ${by + 1} 9 ${by - 2} L9 ${by - 1} Q0 ${by + 2.5} -9 ${by - 1} Z" fill="#fff"/>`,
    abierta: `<ellipse cx="0" cy="${by + 1}" rx="6" ry="7.5" fill="${C.boca}"/>`,
    habla: `<ellipse cx="0" cy="${by + 1}" rx="6.5" ry="4.5" fill="${C.boca}"/>`,
    o: `<ellipse cx="2" cy="${by}" rx="3.6" ry="4.2" fill="${C.boca}"/>`,
    lado: `<path d="M-8 ${by + 1} Q2 ${by + 1} 10 ${by - 3}" stroke="${C.boca}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`,
    preocupada: `<path d="M-9 ${by + 2} Q0 ${by - 3} 9 ${by + 2}" stroke="${C.boca}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`,
  };
  s += B[E.boca] ?? B.neutra;
  return s;
}

function brazo(x: number, y: number, a1: number, a2: number, frente: boolean, reloj: boolean): string {
  const r = (a: number) => (a * Math.PI) / 180;
  const L1 = 100, L2 = 92;
  const ex = x + Math.sin(r(a1)) * L1, ey = y + Math.cos(r(a1)) * L1;
  const hx = ex + Math.sin(r(a2)) * L2, hy = ey + Math.cos(r(a2)) * L2;
  const col = frente ? C.buzo : C.buzoSombra;
  let s = `<line x1="${x}" y1="${y}" x2="${ex}" y2="${ey}" stroke="${col}" stroke-width="36" stroke-linecap="round"/>`;
  s += `<line x1="${ex}" y1="${ey}" x2="${hx}" y2="${hy}" stroke="${col}" stroke-width="30" stroke-linecap="round"/>`;
  const cx = ex + Math.sin(r(a2)) * (L2 - 14), cy = ey + Math.cos(r(a2)) * (L2 - 14);
  s += `<circle cx="${cx}" cy="${cy}" r="16" fill="${frente ? '#E6E3DC' : '#CDC9C0'}"/>`;
  if (reloj) s += `<circle cx="${hx - Math.sin(r(a2)) * 4}" cy="${hy - Math.cos(r(a2)) * 4}" r="9" fill="${C.reloj}"/>`;
  s += `<ellipse cx="${hx + Math.sin(r(a2)) * 10}" cy="${hy + Math.cos(r(a2)) * 10}" rx="13" ry="15" fill="${frente ? C.piel : C.pielSombra}"/>`;
  return s;
}

function pierna(x: number, ang: number, frente: boolean): string {
  const r = (ang * Math.PI) / 180, L = 258;
  const fx = x + Math.sin(r) * L, fy = -270 + Math.cos(r) * L;
  const col = frente ? C.pantalon : C.pantalonSombra;
  let s = `<line x1="${x}" y1="-270" x2="${fx}" y2="${fy}" stroke="${col}" stroke-width="46" stroke-linecap="round"/>`;
  s += `<rect x="${fx - 26}" y="${fy - 6}" width="62" height="26" rx="12" fill="${C.tenis}"/><rect x="${fx - 26}" y="${fy + 12}" width="62" height="8" rx="4" fill="${C.suela}"/>`;
  return s;
}

export type PoseNum = {
  brazoI: [number, number]; brazoD: [number, number]; piernaI: number; piernaD: number;
  bolsillos?: boolean; mochila?: boolean; inclina: number; respira: number;
};

export const POSES: Record<string, PoseNum> = {
  bolsillos: {brazoI: [-4, -2], brazoD: [6, 3], piernaI: -4, piernaD: 5, bolsillos: true, inclina: 0, respira: 0},
  senala: {brazoI: [-6, -4], brazoD: [70, 100], piernaI: -5, piernaD: 6, inclina: 4, respira: 0},
  camina: {brazoI: [-16, -8], brazoD: [16, 6], piernaI: -14, piernaD: 16, mochila: true, inclina: 0, respira: 0},
  explica: {brazoI: [-8, -4], brazoD: [30, 110], piernaI: -3, piernaD: 4, inclina: -3, respira: 0},
  brazosArriba: {brazoI: [-150, -165], brazoD: [150, 165], piernaI: -6, piernaD: 7, inclina: 0, respira: 0},
};

function cuerpo(P: PoseNum, e: Cara): string {
  let s = `<ellipse cx="0" cy="12" rx="90" ry="12" fill="rgba(0,0,0,0.16)"/>`;
  if (P.mochila) s += `<rect x="-96" y="-450" width="64" height="150" rx="20" fill="${C.mochilaSombra}"/>`;
  s += brazo(-62, -456, P.brazoI[0], P.brazoI[1], false, false);
  s += pierna(-24, P.piernaI, false) + pierna(24, P.piernaD, true);
  const k = 1 + P.respira; // respiración: el torso sube y baja un poco
  s += `<g transform="translate(0 -268) scale(1 ${k}) translate(0 268)">`;
  s += `<path d="M-62 -458 Q-62 -482 -34 -486 L34 -486 Q62 -482 62 -458 L56 -268 Q0 -258 -56 -268 Z" fill="${C.buzo}"/>`;
  s += `<path d="M18 -486 L34 -486 Q62 -482 62 -458 L56 -268 Q40 -264 26 -263 Q38 -380 18 -486 Z" fill="${C.buzoSombra}" opacity="0.7"/>`;
  s += `<path d="M-56 -282 Q0 -272 56 -282 L56 -266 Q0 -256 -56 -266 Z" fill="#E2DED6"/>`;
  s += `<path d="M-20 -482 Q0 -470 20 -482" stroke="#DCD8D0" stroke-width="7" fill="none"/>`;
  if (P.mochila)
    s += `<path d="M-48 -480 Q-40 -400 -44 -330" stroke="${C.mochila}" stroke-width="12" fill="none" stroke-linecap="round"/><path d="M48 -480 Q42 -400 46 -330" stroke="${C.mochila}" stroke-width="12" fill="none" stroke-linecap="round"/>`;
  s += `</g>`;
  if (P.bolsillos) {
    s += `<line x1="62" y1="-456" x2="72" y2="-356" stroke="${C.buzo}" stroke-width="36" stroke-linecap="round"/><line x1="72" y1="-356" x2="56" y2="-284" stroke="${C.buzo}" stroke-width="30" stroke-linecap="round"/><circle cx="58" cy="-292" r="9" fill="${C.reloj}"/>`;
  } else {
    s += brazo(62, -456, P.brazoD[0], P.brazoD[1], true, true);
  }
  const dy = -548 - (k - 1) * 220;
  s += `<rect x="-13" y="${-500 - (k - 1) * 220}" width="26" height="26" fill="${C.pielSombra}"/>`;
  s += `<g transform="translate(0 ${dy}) rotate(${P.inclina}) scale(1.15)">${cara(e)}</g>`;
  return s;
}

const mezclar = (a: PoseNum, b: PoseNum, t: number): PoseNum => {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    brazoI: [l(a.brazoI[0], b.brazoI[0]), l(a.brazoI[1], b.brazoI[1])],
    brazoD: [l(a.brazoD[0], b.brazoD[0]), l(a.brazoD[1], b.brazoD[1])],
    piernaI: l(a.piernaI, b.piernaI), piernaD: l(a.piernaD, b.piernaD),
    bolsillos: t < 0.5 ? a.bolsillos : b.bolsillos, mochila: a.mochila || b.mochila,
    inclina: l(a.inclina, b.inclina), respira: 0,
  };
};

export type SantiProps = {
  frame: number;            // cuadro dentro de la escena
  pose: keyof typeof POSES;
  desdePose?: keyof typeof POSES; // pose anterior: la cambia en 8 cuadros
  expr: Expresion;
  habla?: boolean;          // la voz está sonando: mueve la boca
  caminando?: boolean;
  alto?: number;            // alto en px
  espejo?: boolean;
  giro?: number;            // escala horizontal -1..1 (para dar vueltas)
};

export const Santi: React.FC<SantiProps> = ({frame, pose, desdePose, expr, habla, caminando, alto = 620, espejo, giro = 1}) => {
  const t = desdePose ? Math.min(1, frame / 8) : 1;
  let P = desdePose ? mezclar(POSES[desdePose], POSES[pose], 1 - Math.pow(1 - t, 3)) : {...POSES[pose]};
  P = {...P, respira: Math.sin(frame / 22) * 0.008};
  if (caminando) {
    const f = Math.sin(frame * 0.32);
    P = {...P, piernaI: -16 * f, piernaD: 16 * f, brazoI: [14 * f, 6 * f], brazoD: [-14 * f, -4 * f]};
  }
  if (pose === 'senala') P = {...P, brazoD: [P.brazoD[0] + Math.sin(frame / 9) * 4, P.brazoD[1] + Math.sin(frame / 9) * 5]};
  const base = EXPR[expr];
  const parpadea = frame % 105 > 100 && base.ojos !== 'cerrados';
  let boca = base.boca;
  if (habla && expr !== 'risa' && expr !== 'sorpresa') boca = frame % 8 < 4 ? 'habla' : expr === 'sonrisa' ? 'sonrisa' : 'o';
  const e: Cara = {...base, boca, ojos: parpadea ? 'cerrados' : base.ojos};
  const rebote = caminando ? -Math.abs(Math.sin(frame * 0.32)) * 10 : 0;
  const sx = (espejo ? -1 : 1) * giro;
  return (
    <svg width={(alto * 360) / 720} height={alto} viewBox="-180 -700 360 720" style={{overflow: 'visible'}}>
      <g transform={`translate(0 ${rebote}) scale(${sx} 1)`} dangerouslySetInnerHTML={{__html: cuerpo(P, e)}} />
    </svg>
  );
};
