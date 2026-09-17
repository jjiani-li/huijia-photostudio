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
       Model:          "ep-20260917134606-9qt4p",
       Prompt:         "参考这个LOGO，做一套户外运动品牌视觉设计，品牌名称为GREEN，包括包装袋、帽子、纸盒、手环、挂绳等。绿色视觉主色调，趣味、简约现代风格",
       Image:          volcengine.String("https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imageToimages.png"),
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