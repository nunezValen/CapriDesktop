/** Backend-only integration check: generated image, no screen capture and no local AI startup. */
import { app, nativeImage } from 'electron'
import fs from 'fs'
import { getLlmSettings, setLlmSettings, listCloudModels, describeCloudImage } from './llm-gateway'
import { getCloudRequestStatus } from './cloud-request-status'
export async function runCloudVisionCheck(reportFile: string): Promise<void> {
  const report: Record<string,unknown>={syntheticImageOnly:true,screenCaptured:false}
  try {
    const override=app.commandLine.getSwitchValue('cloud-vision-model')
    if (override) setLlmSettings({visionModel:override})
    const settings=getLlmSettings()
    report.chatModel=settings.model
    report.visionModel=settings.visionModel
    const models=await listCloudModels(settings.baseUrl)
    report.modelListed=models.models.includes(settings.visionModel || '')
    report.availableVisionModels=models.models.filter(m=>/omni|vision|\bvl\b/i.test(m))
    const width=512,height=512,pixels=Buffer.alloc(width*height*4)
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const i=(y*width+x)*4
      pixels[i]=x<width/2 ? 0 : 255
      pixels[i+1]=0
      pixels[i+2]=x<width/2 ? 255 : 0
      pixels[i+3]=255
    }
    const image=nativeImage.createFromBitmap(pixels,{width,height,scaleFactor:1}).toJPEG(90).toString('base64')
    const answer=await describeCloudImage(image,'What color is the left half and what color is the right half? Answer one sentence.')
    report.answer=answer
    report.request=getCloudRequestStatus()
    report.passed=/red/i.test(answer) && /blue/i.test(answer)
    report.chatModelPreserved=getLlmSettings().model===settings.model
  } catch(error) {report.passed=false;report.error=String((error as Error).message)}
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600})
  app.exit(report.passed ? 0 : 1)
}
