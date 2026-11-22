import React, {useState} from 'react';
import {AbsoluteFill, Img, continueRender, delayRender, interpolate, spring, staticFile, useVideoConfig} from 'remotion';

// Biblioteca de piezas reutilizables para los videos de YouTube (crece por destino).
// Reglas: docs/09-reglas-reels.md + docs/03-youtube.md. Letra sólida (sin contorno ni sombra),
// Bebas Neue predominante, Playfair Italic para lo emotivo, Montserrat para datos.

export const PAL = {
  papel: '#EAD7BC', papel2: '#F4E9D8', terracota: '#E3A57E', sol: '#E07A4F', arena: '#C98A50',
  arenaOsc: '#A86B3A', tinta: '#2E2420', agua: '#8FB3B0', aguaOsc: '#6E9592', amarillo: '#FFD54A',
  verde: '#2F8F5B', rojo: '#C8473A', italiaVerde: '#009246', italiaRojo: '#CE2B37', blanco: '#FFFFFF',
};
export const F = {bebas: 'Bebas Neue', playfair: 'Playfair Display', mont: 'Montserrat'};

// ---------------------------------------------------------------- tipografías
const FUENTES: [string, string, string, string][] = [
  [F.bebas, 'fuentes/BebasNeue-Regular.ttf', 'normal', '400'],
  [F.playfair, 'fuentes/PlayfairDisplay-Italic.ttf', 'italic', '400'],
  [F.playfair, 'fuentes/PlayfairDisplay-BoldItalic.ttf', 'italic', '700'],
  [F.mont, 'fuentes/Montserrat-ExtraBold.ttf', 'normal', '800'],
  [F.mont, 'fuentes/Montserrat-Bold.ttf', 'normal', '700'],
];
export const useFuentes = () => {
  const [h] = useState(() => delayRender('fuentes'));
  useState(() => {
    Promise.all(
      FUENTES.map(([n, u, st, w]) =>
        new FontFace(n, `url(${staticFile(u)})`, {style: st, weight: w}).load().then((f) => document.fonts.add(f)),
      ),
    ).then(() => continueRender(h));
    return 0;
  });
};

// ---------------------------------------------------------------- animación
export const pop = (f: number, fps: number, desde: number) =>
  spring({frame: f - desde, fps, config: {damping: 11, stiffness: 170, mass: 0.7}});
export const entra = (f: number, desde: number, dur = 10) =>
  interpolate(f, [desde, desde + dur], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
export const s2f = (s: number) => Math.round(s * 30);

// ---------------------------------------------------------------- papel con grano
export const Grano: React.FC<{frame: number; fuerza?: number}> = ({frame, fuerza = 0.13}) => (
  <AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'multiply'}}>
    <svg width="1920" height="1080">
      <filter id="g">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={Math.floor(frame / 3) % 7} stitchTiles="stitch" />
        <feColorMatrix values={`0 0 0 0 0.35  0 0 0 0 0.28  0 0 0 0 0.22  0 0 0 ${fuerza} 0`} />
      </filter>
      <rect width="1920" height="1080" filter="url(#g)" />
    </svg>
  </AbsoluteFill>
);

// ---------------------------------------------------------------- texto
type TextoProps = {
  f: number; desde: number; x: number; y: number; tam: number; fuente?: 'bebas' | 'playfair' | 'mont';
  color?: string; entrada?: 'pop' | 'golpe' | 'sube'; ancla?: 'centro' | 'izq'; peso?: number; children: React.ReactNode;
  espaciado?: number;
};
export const Texto: React.FC<TextoProps> = ({f, desde, x, y, tam, fuente = 'bebas', color = PAL.tinta, entrada = 'pop', ancla = 'centro', peso, children, espaciado}) => {
  const {fps} = useVideoConfig();
  if (f < desde) return null;
  let escala = 1, op = 1, dy = 0;
  if (entrada === 'pop') escala = pop(f, fps, desde);
  if (entrada === 'golpe') {
    const t = entra(f, desde, 6);
    escala = interpolate(t, [0, 1], [2.2, 1]);
    op = t;
  }
  if (entrada === 'sube') {
    const t = entra(f, desde, 12);
    op = t;
    dy = (1 - t) * 30;
  }
  return (
    <div style={{
      position: 'absolute', left: x, top: y, transform: `translate(${ancla === 'centro' ? '-50%' : '0'}, -50%) translateY(${dy}px) scale(${escala})`,
      transformOrigin: ancla === 'centro' ? 'center' : 'left center', opacity: op, whiteSpace: 'nowrap',
      fontFamily: F[fuente], fontStyle: fuente === 'playfair' ? 'italic' : 'normal',
      fontWeight: peso ?? (fuente === 'mont' ? 800 : fuente === 'playfair' ? 400 : 400), fontSize: tam, color,
      lineHeight: 1, letterSpacing: espaciado ?? (fuente === 'bebas' ? 2 : 0),
    }}>
      {children}
    </div>
  );
};

// caja sólida (énfasis): amarilla con texto oscuro por defecto
export const Caja: React.FC<Omit<TextoProps, 'fuente'> & {fondo?: string; giro?: number}> = ({fondo = PAL.amarillo, color = PAL.tinta, giro = -2, ...p}) => {
  const {fps} = useVideoConfig();
  if (p.f < p.desde) return null;
  const e = pop(p.f, fps, p.desde);
  return (
    <div style={{
      position: 'absolute', left: p.x, top: p.y, transform: `translate(-50%, -50%) rotate(${giro}deg) scale(${e})`,
      background: fondo, color, fontFamily: F.bebas, fontSize: p.tam, lineHeight: 1, padding: `${p.tam * 0.12}px ${p.tam * 0.3}px ${p.tam * 0.05}px`,
      borderRadius: 10, whiteSpace: 'nowrap', letterSpacing: 2,
    }}>
      {p.children}
    </div>
  );
};

// número que cuenta rápido y se queda con un golpe
export const Contador: React.FC<{f: number; desde: number; de: number; a: number; dur?: number; x: number; y: number; tam: number; color?: string; antes?: string; despues?: string; sinMiles?: boolean}> = (
  {f, desde, de, a, dur = 18, x, y, tam, color = PAL.tinta, antes = '', despues = '', sinMiles},
) => {
  if (f < desde) return null;
  const t = entra(f, desde, dur);
  const v = Math.round(de + (a - de) * (1 - Math.pow(1 - t, 3)));
  const golpe = f > desde + dur ? interpolate(f, [desde + dur, desde + dur + 5], [1.15, 1], {extrapolateRight: 'clamp'}) : 1;
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${golpe})`, fontFamily: F.bebas, fontSize: tam, color, lineHeight: 1, whiteSpace: 'nowrap'}}>
      {antes}{sinMiles ? v : v.toLocaleString('es-CO')}{despues}
    </div>
  );
};

// sello de pasaporte (papel marfil, doble borde en el color del país)
export const Sello: React.FC<{f: number; desde: number; x: number; y: number; texto: string; sub: string; color: string; giro?: number; ancho?: number}> = (
  {f, desde, x, y, texto, sub, color, giro = -8, ancho = 420},
) => {
  if (f < desde) return null;
  const t = entra(f, desde, 5);
  const esc = interpolate(t, [0, 1], [1.9, 1]);
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) rotate(${giro}deg) scale(${esc})`, opacity: t,
      background: '#F5F1EA', padding: 14, borderRadius: 6}}>
      <div style={{border: `8px solid ${color}`, padding: 6}}>
        <div style={{border: `3px solid ${color}`, width: ancho, padding: '14px 0 10px', textAlign: 'center', color}}>
          <div style={{fontFamily: F.bebas, fontSize: 104, lineHeight: 0.95}}>{texto}</div>
          <div style={{fontFamily: F.mont, fontWeight: 800, fontSize: 28, letterSpacing: 3}}>{sub}</div>
        </div>
      </div>
    </div>
  );
};

// foto real a pantalla completa con movimiento lento y color cálido
export const FotoReal: React.FC<{f: number; dur: number; src: string; foco?: [number, number]; zoom?: [number, number]; panX?: number}> = (
  {f, dur, src, foco = [50, 50], zoom = [1.05, 1.18], panX = 0},
) => {
  const t = Math.min(1, f / dur);
  const e = 1 - Math.pow(1 - t, 2);
  const z = zoom[0] + (zoom[1] - zoom[0]) * e;
  return (
    <AbsoluteFill style={{overflow: 'hidden', background: '#000'}}>
      <Img src={staticFile(src)} style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${foco[0]}% ${foco[1]}%`,
        transform: `scale(${z}) translateX(${panX * e}px)`, filter: 'saturate(1.1) contrast(1.04) brightness(1.05) sepia(0.1)'}} />
    </AbsoluteFill>
  );
};

// velo oscuro difuso detrás del texto sobre foto (la letra sigue sólida)
export const Velo: React.FC<{y: number; alto: number; op?: number}> = ({y, alto, op = 0.45}) => (
  <div style={{position: 'absolute', left: 0, right: 0, top: y - alto / 2, height: alto,
    background: `linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,${op}) 30%, rgba(0,0,0,${op}) 70%, rgba(0,0,0,0))`}} />
);

// ---------------------------------------------------------------- fondos tipo póster
export const FondoVenecia: React.FC<{f: number}> = ({f}) => {
  const ola = (k: number) => Math.sin(f / 18 + k) * 6;
  const gx = 1500 - ((f * 1.2) % 2300);
  return (
    <AbsoluteFill>
      <svg width="1920" height="1080">
        <defs>
          <linearGradient id="cielo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F1DEC2" /><stop offset="1" stopColor="#EBC39A" /></linearGradient>
        </defs>
        <rect width="1920" height="1080" fill="url(#cielo)" />
        <circle cx="1380" cy="470" r="250" fill={PAL.sol} opacity="0.85" />
        {/* skyline: palacios, campanile y la cúpula de la Salute */}
        <g fill={PAL.arena}>
          <rect x="80" y="560" width="260" height="200" /><rect x="340" y="600" width="200" height="160" />
          <rect x="980" y="580" width="300" height="180" /><rect x="1500" y="610" width="420" height="150" />
          <rect x="560" y="300" width="70" height="460" /><polygon points="560,300 595,220 630,300" />
        </g>
        <g fill={PAL.arenaOsc}>
          <rect x="700" y="540" width="260" height="220" /><ellipse cx="830" cy="540" rx="120" ry="110" />
          <rect x="818" y="400" width="24" height="40" /><circle cx="830" cy="395" r="12" />
          <rect x="1280" y="560" width="200" height="200" />
        </g>
        <g fill="#F4E9D8" opacity="0.8">
          {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x={110 + i * 38} y={610} width="16" height="34" rx="8" />)}
          {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={'b' + i} x={1010 + i * 38} y={630} width="16" height="34" rx="8" />)}
        </g>
        {/* agua */}
        <rect y="760" width="1920" height="320" fill={PAL.agua} />
        {[0, 1, 2, 3].map((k) => (
          <path key={k} d={`M0 ${820 + k * 60 + ola(k)} Q480 ${800 + k * 60 - ola(k)} 960 ${820 + k * 60 + ola(k)} T1920 ${820 + k * 60}`} stroke={PAL.aguaOsc} strokeWidth="6" fill="none" opacity="0.6" />
        ))}
        {/* góndola que pasa */}
        <g transform={`translate(${gx} 845)`} fill={PAL.tinta}>
          <path d="M0 0 Q160 30 320 0 Q330 -22 342 -40 L336 -6 Q160 46 -10 -8 Z" />
          <rect x="230" y="-110" width="8" height="110" /><circle cx="234" cy="-122" r="12" />
        </g>
      </svg>
    </AbsoluteFill>
  );
};

// fachada del Duomo de Milán que se construye por capas (progreso 0..1)
export const FondoDuomo: React.FC<{f: number; progreso: number}> = ({f, progreso}) => {
  const capa = (k: number) => Math.max(0, Math.min(1, progreso * 5 - k));
  const agujas = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return (
    <AbsoluteFill>
      <svg width="1920" height="1080">
        <rect width="1920" height="1080" fill={PAL.papel} />
        <circle cx="1480" cy="300" r="190" fill={PAL.terracota} opacity="0.6" />
        <rect y="900" width="1920" height="180" fill="#DCC3A2" />
        <g transform={`translate(0 ${(1 - capa(0)) * 400})`} opacity={capa(0)}>
          <rect x="760" y="560" width="860" height="340" fill="#F2EADF" />
          <rect x="1120" y="680" width="140" height="220" rx="70" fill={PAL.arenaOsc} />
          {[0, 1, 2, 3].map((i) => <rect key={i} x={830 + i * 90 + (i > 1 ? 380 : 0)} y="700" width="46" height="120" rx="23" fill="#CDB89C" />)}
        </g>
        <g transform={`translate(0 ${(1 - capa(1)) * 300})`} opacity={capa(1)}>
          <polygon points="760,560 1190,330 1620,560" fill="#E9DFD0" />
          <circle cx="1190" cy="470" r="60" fill="#CDB89C" />
        </g>
        {agujas.map((i) => {
          const c = capa(2 + (i / agujas.length) * 2.5);
          const x = 780 + i * 82;
          const h = i === 5 ? 380 : 150 + (i % 3) * 40;
          return (
            <g key={i} opacity={c} transform={`translate(0 ${(1 - c) * 120})`}>
              <rect x={x - 9} y={560 - h} width="18" height={h} fill="#EFE6D8" />
              <polygon points={`${x - 13},${560 - h} ${x},${520 - h} ${x + 13},${560 - h}`} fill="#E2D6C3" />
              {i === 5 && <circle cx={x} cy={500 - h} r="12" fill={PAL.amarillo} />}
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};

// mapa del norte de Italia, estilo póster
export const CIUDADES = {milan: [700, 560] as [number, number], venecia: [1240, 520] as [number, number]};
export const MapaItalia: React.FC<{f: number; ruta?: number; pinMilan?: number; pinVenecia?: number; tren?: number}> = (
  {f, ruta = 0, pinMilan = -1, pinVenecia = -1, tren = -1},
) => {
  const {fps} = useVideoConfig();
  const [mx, my] = CIUDADES.milan, [vx, vy] = CIUDADES.venecia;
  const punto = (t: number) => [mx + (vx - mx) * t, my + (vy - my) * t - Math.sin(t * Math.PI) * 70];
  const pasos = 40;
  const camino = Array.from({length: pasos + 1}, (_, i) => punto((i / pasos) * ruta)).map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  const pin = (x: number, y: number, desde: number, nombre: string, abajo = 90) => {
    if (desde < 0 || f < desde) return null;
    const e = pop(f, fps, desde);
    return (
      <g transform={`translate(${x} ${y}) scale(${e})`}>
        <path d="M0 0 C-30 -38 -36 -58 -36 -72 C-36 -96 -20 -112 0 -112 C20 -112 36 -96 36 -72 C36 -58 30 -38 0 0 Z" fill={PAL.rojo} />
        <circle cx="0" cy="-74" r="15" fill="#F5F1EA" />
        <text x="0" y={abajo - 40} textAnchor="middle" fontFamily={F.bebas} fontSize="68" fill={PAL.tinta}>{nombre}</text>
      </g>
    );
  };
  const [tx, ty] = tren >= 0 ? punto(Math.min(1, tren)) : [0, 0];
  return (
    <AbsoluteFill>
      <svg width="1920" height="1080">
        <rect width="1920" height="1080" fill={PAL.agua} />
        {/* tierra: norte de Italia y la costa del Adriático */}
        <path d="M0 0 L1920 0 L1920 260 Q1700 330 1560 420 Q1420 520 1380 640 Q1330 780 1420 900 Q1480 1000 1560 1080 L0 1080 Z" fill={PAL.papel} />
        <path d="M0 980 Q300 900 520 1080 L0 1080 Z" fill={PAL.agua} />
        {/* Alpes */}
        {Array.from({length: 14}, (_, i) => (
          <polygon key={i} points={`${60 + i * 120},${300 - (i % 3) * 30} ${130 + i * 120},${170 - (i % 2) * 40} ${200 + i * 120},${300 - (i % 3) * 30}`} fill={i % 2 ? '#D9BD99' : '#CFAF88'} />
        ))}
        {Array.from({length: 14}, (_, i) => (
          <polygon key={'n' + i} points={`${108 + i * 120},${212 - (i % 2) * 40} ${130 + i * 120},${170 - (i % 2) * 40} ${152 + i * 120},${212 - (i % 2) * 40}`} fill="#F7F2EA" />
        ))}
        {/* lagos */}
        <ellipse cx="640" cy="400" rx="20" ry="60" fill={PAL.agua} /><ellipse cx="880" cy="410" rx="16" ry="56" fill={PAL.agua} />
        <text x="1650" y="700" textAnchor="middle" fontFamily={F.playfair} fontStyle="italic" fontSize="44" fill={PAL.aguaOsc}>Mar Adriático</text>
        <text x="900" y="250" textAnchor="middle" fontFamily={F.mont} fontWeight="800" letterSpacing="14" fontSize="26" fill="#9C8466">ALPES</text>
        {ruta > 0 && <path d={camino} stroke={PAL.tinta} strokeWidth="9" strokeDasharray="22 16" fill="none" strokeLinecap="round" />}
        {pin(mx, my, pinMilan, 'MILÁN')}
        {pin(vx, vy, pinVenecia, 'VENECIA')}
        {tren >= 0 && (
          <g transform={`translate(${tx} ${ty - 70 * Math.min(1, Math.max(0, (tren - 0.75) * 4))})`}>
            <rect x="-62" y="-34" width="124" height="56" rx="18" fill={PAL.rojo} />
            <rect x="-48" y="-24" width="30" height="20" rx="4" fill="#F5F1EA" /><rect x="-12" y="-24" width="30" height="20" rx="4" fill="#F5F1EA" />
            <rect x="22" y="-24" width="28" height="20" rx="4" fill="#F5F1EA" />
            <circle cx="-34" cy="26" r="9" fill={PAL.tinta} /><circle cx="34" cy="26" r="9" fill={PAL.tinta} />
          </g>
        )}
      </svg>
    </AbsoluteFill>
  );
};

// boleto (tren o entrada)
export const Boleto: React.FC<{f: number; desde: number; x: number; y: number; titulo: string; precio: string; nota: string; color: string; marca?: 'si' | 'no'; marcaDesde?: number; giro?: number}> = (
  {f, desde, x, y, titulo, precio, nota, color, marca, marcaDesde = 0, giro = 0},
) => {
  const {fps} = useVideoConfig();
  if (f < desde) return null;
  const e = pop(f, fps, desde);
  const m = marca && f >= marcaDesde ? pop(f, fps, marcaDesde) : 0;
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) rotate(${giro}deg) scale(${e})`}}>
      <div style={{width: 520, height: 300, background: '#F7F1E6', borderRadius: 22, position: 'relative', overflow: 'hidden'}}>
        <div style={{height: 70, background: color, color: '#fff', fontFamily: F.mont, fontWeight: 800, fontSize: 30, letterSpacing: 4, display: 'flex', alignItems: 'center', paddingLeft: 30}}>{titulo}</div>
        <div style={{fontFamily: F.bebas, fontSize: 150, color: PAL.tinta, paddingLeft: 30, lineHeight: 1.05}}>{precio}</div>
        <div style={{fontFamily: F.mont, fontWeight: 700, fontSize: 28, color: '#7A6A5C', paddingLeft: 32}}>{nota}</div>
        <div style={{position: 'absolute', right: -22, top: 128, width: 44, height: 44, borderRadius: 22, background: PAL.papel}} />
        <div style={{position: 'absolute', left: 380, top: 80, bottom: 20, borderLeft: '4px dashed #D5C6B0'}} />
      </div>
      {m > 0 && (
        <div style={{position: 'absolute', right: -40, top: -50, width: 130, height: 130, borderRadius: 65, background: marca === 'si' ? PAL.verde : PAL.rojo,
          transform: `scale(${m})`, color: '#fff', fontFamily: F.mont, fontWeight: 800, fontSize: 84, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
          {marca === 'si' ? '✓' : '✗'}
        </div>
      )}
    </div>
  );
};

// código QR (decorativo, determinista)
export const QR: React.FC<{tam: number}> = ({tam}) => {
  const n = 21, c = tam / n;
  const celdas: React.ReactNode[] = [];
  const esquina = (x: number, y: number) => (x < 7 && y < 7) || (x > n - 8 && y < 7) || (x < 7 && y > n - 8);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (esquina(x, y)) continue;
      if (((x * 7 + y * 13 + x * y) % 5) < 2) celdas.push(<rect key={x + '-' + y} x={x * c} y={y * c} width={c} height={c} fill={PAL.tinta} />);
    }
  const ojo = (x: number, y: number) => (
    <g key={'o' + x + y}><rect x={x * c} y={y * c} width={7 * c} height={7 * c} fill={PAL.tinta} /><rect x={(x + 1) * c} y={(y + 1) * c} width={5 * c} height={5 * c} fill="#fff" /><rect x={(x + 2) * c} y={(y + 2) * c} width={3 * c} height={3 * c} fill={PAL.tinta} /></g>
  );
  return <svg width={tam} height={tam}><rect width={tam} height={tam} fill="#fff" />{celdas}{ojo(0, 0)}{ojo(n - 7, 0)}{ojo(0, n - 7)}</svg>;
};
