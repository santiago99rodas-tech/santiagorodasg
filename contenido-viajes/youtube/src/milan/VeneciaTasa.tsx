import React from 'react';
import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Santi, Expresion, POSES} from '../santi/Santi';
import {
  Boleto, Caja, Capitulo, F, FondoLiso, FondoVenecia, Grano, Lista, PAL, Polaroid, QR, Sticker, TarjetaTitulo, Texto, entra, pop, s2f, useFuentes,
} from '../piezas';
import {PALABRAS_V2} from './palabras-v2';

// Prototipo de YouTube de 1 minuto, v2: "Venecia cobra por entrar" (guiones/milan-venecia-youtube-1min-v2.md).
// Formato YouTube explicativo (docs/10): Santi presenta en plano base, capítulos con nombre, fotos naturales solo
// como apoyo, cortes limpios, texto escaso. Tiempos en segundos sobre la voz v2 (voz-v2.mp3).
export const DURACION_V2 = 63.1;

const habla = (t: number) => PALABRAS_V2.some(([a, b]) => t >= a - 0.03 && t <= b + 0.03);

// corte limpio con un fundido corto (sin zoom): el lenguaje de un explicador, no de un reel
const Escena: React.FC<{desde: number; hasta: number; children: (f: number, t0: number) => React.ReactNode}> = ({desde, hasta, children}) => (
  <Sequence from={s2f(desde)} durationInFrames={s2f(hasta) - s2f(desde)}>
    <Interior t0={desde}>{children}</Interior>
  </Sequence>
);
const Interior: React.FC<{t0: number; children: (f: number, t0: number) => React.ReactNode}> = ({t0, children}) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{opacity: interpolate(f, [0, 4], [0, 1], {extrapolateRight: 'clamp'})}}>{children(f, t0)}</AbsoluteFill>;
};

const SantiEn: React.FC<{f: number; t0: number; x: number; y?: number; alto?: number; pose: keyof typeof POSES; desdePose?: keyof typeof POSES; expr: Expresion;
  caminando?: boolean; espejo?: boolean; entra?: boolean}> = ({f, t0, x, y = 1040, alto = 800, entra: conEntrada = false, ...p}) => {
  const {fps} = useVideoConfig();
  const e = conEntrada ? Math.min(1, pop(f, fps, 0)) : 1;
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -100%) translateY(${(1 - e) * 120}px)`}}>
      <Santi frame={f} habla={habla(t0 + f / 30)} alto={alto} {...p} />
    </div>
  );
};

const k = (t: number, t0: number) => s2f(t - t0);

// torniquete de entrada "de museo"
const Torniquete: React.FC<{f: number}> = ({f}) => {
  const g = (f * 3) % 120;
  return (
    <svg width="520" height="420" viewBox="0 0 520 420" style={{position: 'absolute', left: 950, top: 590}}>
      <rect x="40" y="60" width="90" height="340" rx="14" fill="#8D8F96" />
      <rect x="390" y="60" width="90" height="340" rx="14" fill="#8D8F96" />
      <rect x="52" y="80" width="66" height="40" rx="8" fill={PAL.rojo} />
      <circle cx="85" cy="100" r="10" fill="#F7F1E6" />
      <g transform={`translate(135 190) rotate(${g})`}>
        {[0, 120, 240].map((a) => <rect key={a} x="0" y="-8" width="200" height="16" rx="8" fill="#B9BEC5" transform={`rotate(${a})`} />)}
        <circle r="22" fill="#6E7077" />
      </g>
      <rect x="0" y="396" width="520" height="24" fill="#CDB89C" />
    </svg>
  );
};

// mapa de la laguna: Venecia (isla) y Mestre (tierra firme) unidas por el puente
const MapaLaguna: React.FC<{f: number; pinVenecia: number; pinMestre: number}> = ({f, pinVenecia, pinMestre}) => {
  const {fps} = useVideoConfig();
  const pin = (x: number, y: number, desde: number, nombre: string, color: string) => {
    if (f < desde) return null;
    const e = pop(f, fps, desde);
    return (
      <g transform={`translate(${x} ${y}) scale(${e})`}>
        <path d="M0 0 C-30 -38 -36 -58 -36 -72 C-36 -96 -20 -112 0 -112 C20 -112 36 -96 36 -72 C36 -58 30 -38 0 0 Z" fill={color} />
        <circle cx="0" cy="-74" r="15" fill="#F5F1EA" />
        <text x="0" y="62" textAnchor="middle" fontFamily={F.bebas} fontSize="72" fill={PAL.tinta}>{nombre}</text>
      </g>
    );
  };
  return (
    <AbsoluteFill>
      <svg width="1920" height="1080">
        <rect width="1920" height="1080" fill={PAL.agua} />
        {/* tierra firme (Mestre) */}
        <path d="M0 0 L1300 0 Q1180 120 980 190 Q760 260 640 380 Q540 480 380 520 Q200 560 0 600 Z" fill={PAL.papel} />
        {/* el Lido: franja larga que cierra la laguna */}
        <path d="M1700 300 Q1760 600 1640 1080 L1700 1080 Q1820 600 1750 300 Z" fill={PAL.papel} />
        {/* Venecia (con forma de pez) */}
        <path d="M900 640 Q960 560 1100 560 Q1260 555 1330 610 Q1360 640 1330 680 Q1260 740 1100 735 Q980 730 930 700 Q860 720 820 700 Q850 670 900 640 Z" fill={PAL.papel} />
        <path d="M960 650 Q1080 610 1180 660 Q1250 690 1300 640" stroke={PAL.aguaOsc} strokeWidth="9" fill="none" opacity="0.7" />
        {/* Ponte della Libertà */}
        <path d="M560 430 L880 640" stroke="#B99A74" strokeWidth="16" />
        <path d="M560 430 L880 640" stroke="#E9DCC8" strokeWidth="5" strokeDasharray="14 10" />
        <text x="1480" y="900" textAnchor="middle" fontFamily={F.playfair} fontStyle="italic" fontSize="46" fill={PAL.aguaOsc}>Laguna de Venecia</text>
        {pin(1100, 640, pinVenecia, 'VENECIA', PAL.rojo)}
        {pin(470, 400, pinMestre, 'MESTRE', PAL.rojo)}
      </svg>
    </AbsoluteFill>
  );
};

// reloj que avanza de 8:30 a 16:00
const Reloj: React.FC<{f: number; x: number; y: number; avance: number}> = ({f, x, y, avance}) => {
  const min = 8.5 * 60 + avance * 7.5 * 60;
  const h = Math.floor(min / 60), m = min % 60;
  const aH = ((h % 12) + m / 60) * 30, aM = m * 6;
  return (
    <svg width="460" height="460" viewBox="-230 -230 460 460" style={{position: 'absolute', left: x - 230, top: y - 230, transform: `scale(${Math.min(1, pop(f, 30, 0))})`}}>
      <circle r="220" fill="#F7F1E6" />
      <circle r="220" fill="none" stroke={PAL.tinta} strokeWidth="14" />
      {Array.from({length: 12}, (_, i) => <rect key={i} x="-5" y="-200" width="10" height={i % 3 ? 22 : 40} fill={PAL.tinta} transform={`rotate(${i * 30})`} />)}
      <rect x="-9" y="-120" width="18" height="130" rx="9" fill={PAL.tinta} transform={`rotate(${aH})`} />
      <rect x="-6" y="-180" width="12" height="190" rx="6" fill={PAL.rojo} transform={`rotate(${aM})`} />
      <circle r="16" fill={PAL.tinta} />
    </svg>
  );
};

const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

export const VeneciaTasa: React.FC = () => {
  useFuentes();
  const fg = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: PAL.papel2}}>
      {/* 1. PLANO BASE · gancho: desde 2024 Venecia cobra por entrar */}
      <Escena desde={0} hasta={4.0}>{(f, t0) => <>
        <FondoLiso x={520} />
        <SantiEn f={f} t0={t0} x={520} pose="bolsillos" expr={f < k(0.44, t0) ? 'neutral' : 'sorpresa'} />
        <Texto f={f} desde={2} x={1300} y={250} tam={46} fuente="mont" color="#7A6A5C" espaciado={10}>DESDE</Texto>
        <Texto f={f} desde={k(0.44, t0)} x={1300} y={470} tam={340} entrada="golpe">2024</Texto>
        <Texto f={f} desde={k(2.08, t0)} x={1300} y={720} tam={84} entrada="sube">VENECIA TE COBRA POR ENTRAR</Texto>
      </>}</Escena>

      {/* 2. ACTOR · como si fuera un museo: torniquete con póster de Venecia */}
      <Escena desde={4.0} hasta={8.25}>{(f, t0) => <>
        <AbsoluteFill style={{background: '#EFE3CF'}} />
        <div style={{position: 'absolute', left: 0, right: 0, top: 990, bottom: 0, background: '#CDB89C'}} />
        <div style={{position: 'absolute', left: 90, top: 170, width: 768, height: 432, overflow: 'hidden', border: '18px solid #6B4A35', boxSizing: 'content-box'}}>
          <div style={{transform: 'scale(0.4)', transformOrigin: 'top left', width: 1920, height: 1080}}><FondoVenecia f={f} /></div>
        </div>
        <div style={{position: 'absolute', left: 930, top: 430, width: 560, whiteSpace: 'nowrap', background: PAL.tinta, color: '#F4E9D8', fontFamily: F.bebas, fontSize: 80,
          textAlign: 'center', padding: '14px 0 6px', letterSpacing: 6, borderRadius: 6}}>VENECIA · ENTRADA</div>
        <Torniquete f={f} />
        <SantiEn f={f} t0={t0} x={1600} pose="bolsillos" expr="duda" espejo />
        <Caja f={f} desde={k(6.94, t0)} x={480} y={720} tam={96} giro={-3}>COMO UN MUSEO</Caja>
      </>}</Escena>

      {/* 3. APOYO REAL · mi foto de 2023, sin filtro, en polaroid */}
      <Escena desde={8.25} hasta={12.15}>{(f, t0) => <>
        <FondoLiso x={330} />
        <Polaroid f={f} src="milan/f19.jpg" x={1170} y={480} ancho={900} alto={560} pie="Venecia, 2023" foco={[50, 60]} />
        <Sticker f={f} desde={k(9.46, t0)} src="stickers/camara.png" x={1640} y={170} tam={170} />
        <Caja f={f} desde={k(11.48, t0)} x={1440} y={960} tam={100} fondo={PAL.verde} color="#fff" giro={-3}>ERA GRATIS</Caja>
        <SantiEn f={f} t0={t0} x={330} alto={760} pose="senala" desdePose="bolsillos" expr="sonrisa" />
      </>}</Escena>

      {/* 4. PLANO BASE · promesa + agenda */}
      <Escena desde={12.15} hasta={18.95}>{(f, t0) => <>
        <FondoLiso x={480} />
        <SantiEn f={f} t0={t0} x={480} pose="explica" desdePose="bolsillos" expr="sonrisa" />
        <Texto f={f} desde={k(12.54, t0)} x={940} y={250} tam={42} fuente="mont" color="#7A6A5C" ancla="izq" espaciado={8}>EN ESTE VIDEO</Texto>
        <Texto f={f} desde={k(13.8, t0)} x={940} y={340} tam={110} ancla="izq" entrada="sube">3 COSAS</Texto>
        <Lista f={f} x={940} y={430} tam={86} numerada items={[
          {desde: k(15.16, t0), texto: '¿CUÁNDO SE PAGA?'},
          {desde: k(16.68, t0), texto: '¿CUÁNTO CUESTA?'},
          {desde: k(17.8, t0), texto: '¿CÓMO NO PAGARLA?'},
        ]} />
      </>}</Escena>

      {/* 5. TARJETA DE TÍTULO */}
      <Escena desde={18.95} hasta={20.75}>{(f) => <TarjetaTitulo f={f} titulo="VENECIA COBRA POR ENTRAR" sub="lo que tienes que saber antes de ir" />}</Escena>

      {/* 6. CAPÍTULO 1 · ¿CUÁNDO SE PAGA? */}
      <Escena desde={20.75} hasta={24.85}>{(f, t0) => {
        const marca = k(23.68, t0);
        return <>
          <AbsoluteFill style={{background: PAL.papel2}} />
          <div style={{position: 'absolute', left: 140, top: 230, display: 'grid', gridTemplateColumns: 'repeat(4, 250px)', gap: 20, opacity: entra(f, 2, 8)}}>
            {MESES.map((m, i) => {
              const on = i >= 3 && i <= 6 && f >= marca + (i - 3) * 4;
              return <div key={m} style={{height: 170, borderRadius: 16, background: on ? PAL.amarillo : '#EADFCB', fontFamily: F.bebas, fontSize: 84, color: on ? PAL.tinta : '#9C8466',
                display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${on ? 1.05 : 1})`}}>{m}</div>;
            })}
          </div>
          <Texto f={f} desde={k(21.96, t0)} x={670} y={880} tam={52} fuente="playfair" color="#7A6A5C">no es todo el año…</Texto>
          <Caja f={f} desde={k(24.36, t0)} x={670} y={980} tam={80} giro={-2}>SOLO DE ABRIL A JULIO</Caja>
          <SantiEn f={f} t0={t0} x={1640} alto={760} pose="explica" expr={f < marca ? 'neutral' : 'sonrisa'} espejo />
        </>;
      }}</Escena>
      <Escena desde={24.85} hasta={27.8}>{(f, t0) => <>
        <AbsoluteFill style={{background: PAL.papel2}} />
        <Reloj f={f} x={760} y={540} avance={entra(f, k(25.14, t0), k(27.0, t0) - k(25.14, t0))} />
        <Texto f={f} desde={k(25.14, t0)} x={1320} y={430} tam={150} ancla="izq">8:30</Texto>
        <Texto f={f} desde={k(26.76, t0)} x={1320} y={600} tam={150} ancla="izq" color={PAL.rojo}>16:00</Texto>
        <Texto f={f} desde={k(25.14, t0)} x={1330} y={330} tam={34} fuente="mont" color="#7A6A5C" ancla="izq" espaciado={6}>HORARIO</Texto>
      </>}</Escena>
      <Escena desde={27.8} hasta={29.95}>{(f, t0) => <>
        <FondoLiso x={960} />
        <SantiEn f={f} t0={t0} x={interpolate(f, [0, 64], [700, 1000])} alto={780} pose="camina" expr="sonrisa" caminando />
        <Caja f={f} desde={k(28.18, t0)} x={960} y={190} tam={110} giro={-2}>SOLO SI VAS POR EL DÍA</Caja>
      </>}</Escena>
      <Sequence from={s2f(20.75)} durationInFrames={s2f(29.95) - s2f(20.75)}><CapEtiqueta n={1} titulo="¿CUÁNDO SE PAGA?" /></Sequence>

      {/* 7. CAPÍTULO 2 · ¿CUÁNTO CUESTA? */}
      <Escena desde={29.95} hasta={40.6}>{(f, t0) => <>
        <AbsoluteFill style={{background: PAL.papel2}} />
        <Boleto f={f} desde={k(30.36, t0)} x={620} y={500} titulo="4 DÍAS ANTES O MÁS" precio="5 €" nota="reservando con tiempo" color={PAL.verde} marca="si" marcaDesde={k(34.04, t0)} giro={-3} />
        <Boleto f={f} desde={k(37.64, t0)} x={1180} y={560} titulo="ÚLTIMOS 3 DÍAS" precio="10 €" nota="a última hora" color={PAL.rojo} giro={3} />
        <Caja f={f} desde={k(39.24, t0)} x={1180} y={860} tam={110} fondo={PAL.rojo} color="#fff" giro={-3}>EL DOBLE</Caja>
        <SantiEn f={f} t0={t0} x={1680} alto={760} pose={f < k(37.64, t0) ? 'explica' : 'bolsillos'} desdePose={f < k(37.64, t0) ? undefined : 'explica'}
          expr={f < k(37.64, t0) ? 'sonrisa' : 'ojo'} espejo />
      </>}</Escena>
      <Sequence from={s2f(29.95)} durationInFrames={s2f(40.6) - s2f(29.95)}><CapEtiqueta n={2} titulo="¿CUÁNTO CUESTA?" /></Sequence>

      {/* 8. CAPÍTULO 3 · ¿CÓMO NO PAGARLA? */}
      <Escena desde={40.6} hasta={45.1}>{(f, t0) => <>
        <MapaLaguna f={f} pinVenecia={k(41.86, t0)} pinMestre={k(43.66, t0)} />
        <Sticker f={f} desde={k(41.32, t0)} src="stickers/dormido.png" x={1330} y={480} tam={150} />
        <Caja f={f} desde={k(44.3, t0)} x={1300} y={960} tam={110} fondo={PAL.verde} color="#fff" giro={-3}>DUERMES ALLÁ = 0 €</Caja>
      </>}</Escena>
      <Escena desde={45.1} hasta={49.6}>{(f, t0) => <>
        <FondoLiso x={1500} />
        <Texto f={f} desde={k(46.64, t0)} x={700} y={230} tam={100}>IGUAL TE REGISTRAS</Texto>
        {f >= k(47.98, t0) && (
          <div style={{position: 'absolute', left: 700, top: 600, transform: `translate(-50%,-50%) rotate(-3deg) scale(${pop(f, 30, k(47.98, t0))})`, background: '#fff', padding: 26, borderRadius: 20}}>
            <QR tam={300} />
            <div style={{fontFamily: F.mont, fontWeight: 800, fontSize: 32, textAlign: 'center', marginTop: 12, color: PAL.verde, letterSpacing: 2}}>CÓDIGO GRATIS</div>
          </div>
        )}
        <SantiEn f={f} t0={t0} x={1500} alto={780} pose="senala" desdePose="bolsillos" expr="sonrisa" espejo />
      </>}</Escena>
      <Sequence from={s2f(40.6)} durationInFrames={s2f(49.6) - s2f(40.6)}><CapEtiqueta n={3} titulo="¿CÓMO NO PAGARLA?" /></Sequence>

      {/* 9. PLANO BASE · resumen */}
      <Escena desde={49.6} hasta={55.9}>{(f, t0) => <>
        <FondoLiso x={480} />
        <SantiEn f={f} t0={t0} x={480} pose="explica" expr="sonrisa" />
        <Texto f={f} desde={k(50.12, t0)} x={940} y={250} tam={64} fuente="playfair" ancla="izq" entrada="sube">En resumen</Texto>
        <Lista f={f} x={940} y={360} tam={80} check items={[
          {desde: k(51.06, t0), texto: 'ABRIL A JULIO · 8:30–16:00'},
          {desde: k(52.46, t0), texto: '5 € O 10 €'},
          {desde: k(54.14, t0), texto: 'GRATIS SI DUERMES ALLÁ'},
        ]} />
      </>}</Escena>

      {/* 10. PLANO BASE · una sola pregunta */}
      <Escena desde={55.9} hasta={60.3}>{(f, t0) => <>
        <FondoLiso x={480} />
        <SantiEn f={f} t0={t0} x={480} pose="bolsillos" expr="sonrisa" />
        <Texto f={f} desde={k(56.04, t0)} x={1290} y={380} tam={110} entrada="sube">¿POR EL DÍA</Texto>
        <Texto f={f} desde={k(57.44, t0)} x={1290} y={500} tam={110} entrada="sube">O TE QUEDAS?</Texto>
        <Sticker f={f} desde={k(58.58, t0)} src="stickers/mensaje.png" x={1640} y={720} tam={170} />
        <Texto f={f} desde={k(58.58, t0)} x={1250} y={720} tam={44} fuente="mont" color="#7A6A5C" espaciado={4}>TE LEO EN LOS COMENTARIOS</Texto>
      </>}</Escena>

      {/* 11. FIRMA */}
      <Escena desde={60.3} hasta={DURACION_V2}>{(f, t0) => <>
        <FondoLiso x={480} circulo={PAL.sol} />
        <SantiEn f={f} t0={t0} x={480} pose="senala" expr="sonrisa" />
        <Texto f={f} desde={k(60.52, t0)} x={1330} y={470} tam={150} fuente="playfair" peso={700} entrada="sube">Nos vemos pues</Texto>
        <Texto f={f} desde={k(61.2, t0)} x={1330} y={600} tam={44} fuente="mont" espaciado={8}>SANTIAGO RODAS</Texto>
      </>}</Escena>

      <Grano frame={fg} fuerza={0.07} />
    </AbsoluteFill>
  );
};

const CapEtiqueta: React.FC<{n: number; titulo: string}> = ({n, titulo}) => {
  const f = useCurrentFrame();
  return <Capitulo f={f} n={n} titulo={titulo} />;
};
