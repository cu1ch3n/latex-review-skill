import { Composition } from "remotion";
import { Promo, TIMING } from "./Promo";

export const Root = () => (
  <Composition
    id="LatexReview"
    component={Promo}
    width={1200}
    height={675}
    fps={TIMING.fps}
    durationInFrames={TIMING.duration}
  />
);
