import React from 'react';

// Mascota original del canal: viajero pequeño con sombrero de explorador y mochila.
// Todas las poses salen de props, así se reutiliza en cualquier destino.
export type Pose = {
  frame: number;
  caminando?: boolean;
  senalando?: boolean; // brazo derecho arriba señalando
  sorprendido?: boolean; // ojos grandes y boca abierta
  camara?: boolean; // sostiene una cámara de fotos
  flash?: number; // 0..1 destello de la cámara
  mirando?: 1 | -1; // 1 derecha, -1 izquierda
};

const PIEL = '#F2C9A0';
const CAMISA = '#2BB3A3';
const PANTALON = '#3B4A6B';
const MOCHILA = '#F28C38';
const SOMBRERO = '#D9B46C';
const SOMBRERO_OSC = '#B8924A';
const OSCURO = '#2B1A12';

export const Mascota: React.FC<Pose & {size?: number}> = ({
  frame,
  caminando,
  senalando,
  sorprendido,
  camara,
  flash = 0,
  mirando = 1,
  size = 260,
}) => {
  const paso = caminando ? Math.sin(frame * 0.45) : 0;
  const rebote = caminando ? Math.abs(Math.sin(frame * 0.45)) * -6 : Math.sin(frame * 0.08) * 2;
  const parpadeo = frame % 90 > 85 ? 0.15 : 1;
  const ojo = sorprendido ? 1.35 : 1;

  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 200 250" style={{overflow: 'visible'}}>
      <g transform={`translate(100 0) scale(${mirando} 1) translate(-100 ${rebote})`}>
        {/* sombra */}
        <ellipse cx="100" cy="244" rx="46" ry="7" fill="rgba(0,0,0,0.18)" />
        {/* piernas */}
        <g transform={`rotate(${paso * 22} 85 185)`}>
          <rect x="76" y="182" width="18" height="52" rx="9" fill={PANTALON} />
          <ellipse cx="88" cy="236" rx="15" ry="8" fill={OSCURO} />
        </g>
        <g transform={`rotate(${-paso * 22} 115 185)`}>
          <rect x="106" y="182" width="18" height="52" rx="9" fill={PANTALON} />
          <ellipse cx="118" cy="236" rx="15" ry="8" fill={OSCURO} />
        </g>
        {/* mochila */}
        <rect x="46" y="118" width="40" height="64" rx="12" fill={MOCHILA} />
        <rect x="50" y="146" width="30" height="16" rx="5" fill="#D9702A" />
        {/* cuerpo */}
        <rect x="64" y="112" width="74" height="82" rx="26" fill={CAMISA} />
        <rect x="78" y="112" width="8" height="70" rx="4" fill="#C9572A" />
        {/* brazo trasero */}
        <g transform={`rotate(${caminando ? -paso * 25 : 8} 72 125)`}>
          <rect x="62" y="120" width="16" height="50" rx="8" fill={CAMISA} />
          <circle cx="70" cy="172" r="9" fill={PIEL} />
        </g>
        {/* brazo delantero */}
        <g transform={`rotate(${senalando ? -135 : camara ? -70 : caminando ? paso * 25 : -6} 130 125)`}>
          <rect x="122" y="120" width="16" height="50" rx="8" fill={CAMISA} />
          <circle cx="130" cy="172" r="9" fill={PIEL} />
          {senalando && <rect x="126" y="176" width="8" height="16" rx="4" fill={PIEL} />}
        </g>
        {/* cabeza */}
        <circle cx="100" cy="78" r="46" fill={PIEL} />
        <circle cx="76" cy="92" r="7" fill="#F2A08C" opacity="0.7" />
        <circle cx="124" cy="92" r="7" fill="#F2A08C" opacity="0.7" />
        {/* ojos */}
        <g transform={`translate(0 ${80 * (1 - parpadeo)}) scale(1 ${parpadeo})`}>
          <ellipse cx="86" cy="78" rx={7 * ojo} ry={9 * ojo} fill="white" />
          <ellipse cx="114" cy="78" rx={7 * ojo} ry={9 * ojo} fill="white" />
          <circle cx="88" cy="80" r={4.5 * ojo} fill={OSCURO} />
          <circle cx="116" cy="80" r={4.5 * ojo} fill={OSCURO} />
        </g>
        {/* boca */}
        {sorprendido ? (
          <ellipse cx="102" cy="102" rx="7" ry="9" fill={OSCURO} />
        ) : (
          <path d="M90 98 Q102 110 114 98" stroke={OSCURO} strokeWidth="4" fill="none" strokeLinecap="round" />
        )}
        {/* sombrero de explorador */}
        <ellipse cx="100" cy="46" rx="66" ry="13" fill={SOMBRERO_OSC} />
        <path d="M60 46 Q62 8 100 6 Q138 8 140 46 Z" fill={SOMBRERO} />
        <rect x="61" y="36" width="78" height="9" fill={OSCURO} opacity="0.85" />
        {/* cámara de fotos */}
        {camara && (
          <g>
            <rect x="128" y="60" width="44" height="30" rx="6" fill="#2E2E3A" />
            <circle cx="150" cy="75" r="9" fill="#6FA8DC" stroke="#1B1B24" strokeWidth="3" />
            <rect x="132" y="54" width="12" height="7" rx="2" fill="#2E2E3A" />
            {flash > 0 && <circle cx="160" cy="58" r={30 + flash * 90} fill="white" opacity={flash} />}
          </g>
        )}
      </g>
    </svg>
  );
};
