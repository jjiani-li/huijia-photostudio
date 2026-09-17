// Install:
// go get -u github.com/volcengine/volcengine-go-sdk

package main

import (
    "context"
    "fmt"
    "os"
    "strings"
    
    "github.com/volcengine/volcengine-go-sdk/service/arkruntime"
    "github.com/volcengine/volcengine-go-sdk/service/arkruntime/model"
    "github.com/volcengine/volcengine-go-sdk/volcengine"
)

func main() {
    client := arkruntime.NewClientWithApiKey(os.Getenv("ARK_API_KEY"))
    ctx := context.Background()
    
    var sequentialImageGeneration model.SequentialImageGeneration = "auto"
    maxImages := 5
    generateReq := model.GenerateImagesRequest{
       Model:          "ep-20260917151237-rwqtz",
       Prompt:         "生成3张女孩和奶牛玩偶在游乐园开心地坐过山车的图片，涵盖早晨、中午、晚上",
       Image:         []string{
           "https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imagesToimages_1.png",
           "https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imagesToimages_2.png",
       },

       Size:           volcengine.String("2K"),
       ResponseFormat: volcengine.String(model.GenerateImagesResponseFormatURL),
       Watermark:      volcengine.Bool(true),
       SequentialImageGeneration: &sequentialImageGeneration,
       SequentialImageGenerationOptions: &model.SequentialImageGenerationOptions{
          MaxImages: &maxImages,
       },
    }

     stream, err := client.GenerateImagesStreaming(ctx, generateReq)
        if err != nil {
                fmt.Printf("call GenerateImagesStreaming error: %v\n", err)
                return
        }

        defer stream.Close()

        for {
                recv, err := stream.Recv()
                if err == io.EOF {
                        break
                }
                if err != nil {
                        fmt.Printf("Stream generate images error: %v\n", err)
                        break
                }

                if recv.Type == "image_generation.partial_failed" {
                        fmt.Printf("Stream generate images error: %v\n", recv.Error)
                        if strings.EqualFold(recv.Error.Code, "InternalServiceError") {
                                break
                        }
                }

                if recv.Type == "image_generation.partial_succeeded" {
                        if recv.Error == nil && recv.Url != nil {
                                fmt.Printf("recv.Size: %s, recv.Url: %s\n", recv.Size, *recv.Url)
                        }
                }

                if recv.Type == "image_generation.completed" {
                        if recv.Error == nil {
                                fmt.Printf("recv.Usage: %v\n", *recv.Usage)
                        }
                }
        }
}