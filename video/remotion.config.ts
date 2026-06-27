import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
// Crisp 1080p H.264 with a high quality factor for clean gradients/text.
Config.setCodec("h264");
Config.setCrf(17);
Config.setChromiumOpenGlRenderer("angle");
