import { Config } from "@remotion/cli/config";

// UI text, hairline borders, and gradients do not survive an 80-quality JPEG
// intermediate cleanly. PNG frames keep the master lossless until H.264.
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
// The one place concurrency is set (the npm scripts don't override it).
Config.setConcurrency(4);
// Standard web-video color metadata avoids the full-range/BT.601 interpretation
// some players applied to older exports.
Config.setCodec("h264");
Config.setCrf(17);
// The master is the source of every delivery encode, so spend the (small)
// extra encode time on it: 'slow' over the default 'medium' buys better
// motion search and trellis at the same CRF. Frame rendering, not encoding,
// dominates a render's wall time.
Config.setX264Preset("slow");
Config.setPixelFormat("yuv420p");
Config.setColorSpace("bt709");
Config.setChromiumOpenGlRenderer("angle");
