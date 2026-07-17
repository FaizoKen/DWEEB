import { Config } from "@remotion/cli/config";

// UI text, hairline borders, and gradients do not survive an 80-quality JPEG
// intermediate cleanly. PNG frames keep the master lossless until H.264.
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
// Standard web-video color metadata avoids the full-range/BT.601 interpretation
// some players applied to older exports.
Config.setCodec("h264");
Config.setCrf(17);
Config.setPixelFormat("yuv420p");
Config.setColorSpace("bt709");
Config.setChromiumOpenGlRenderer("angle");
