import React from 'react';
import {Composition} from 'remotion';
import {PruebaEgipto} from './PruebaEgipto';

export const Root: React.FC = () => (
  <Composition id="PruebaEgipto" component={PruebaEgipto} durationInFrames={540} fps={30} width={1920} height={1080} />
);
