// Install:
// npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.['ARK_API_KEY'],
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
});

// Image input:
async function main() {
  const response = await openai.chat.completions.create({
    apiKey: process.env['ARK_API_KEY'],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: 'https://ark-project.tos-cn-beijing.ivolces.com/images/view.jpeg',
            },
          },
          { type: 'text', text: '这是哪里？' },
        ],
      },
    ],
    model: 'ep-20260917150742-vrndp',
  });

  console.log(response.choices[0]);
}

main();