### **4.4 Iteration and Testing**

Ariadne was developed across three milestone phases (Alpha, Beta, and Gold), each closing with a round of user testing whose feedback shaped the next. Each phase had a target scope; in practice, several items slipped to the next phase or were cut in response to that feedback.

#### **4.4.1 Alpha: Core Interaction Prototype**

The Alpha milestone targeted a working end-to-end interaction loop: a greybox escape-room environment supporting 3-4 synchronised players, the asymmetric-visibility puzzle logic, the full audio pipeline (microphone capture, speech recognition, model inference, and speech synthesis), a basic Talker model that could provide acknowledgements and gaze toward the active speaker, and a Redis-backed belief store. What shipped to testers was a single-player Unity client without the belief store; the remaining components landed as planned. Tester feedback drove two changes on the AI side: the Talker's system prompt was rewritten to make its responses more concise, and the STT pipeline was migrated from Deepgram Nova-3 to Deepgram Flux for better end-of-turn and barge-in detection.

#### **4.4.2 Beta: Feature-Complete System**

The Beta milestone aimed for a feature-complete system: final escape-room visuals across all three rooms, full puzzle logic, the Thinker model integrated as a strategic counterpart to the Talker, and three experimental conditions (no-AI control, light intervention, and heavy intervention). At the end of the milestone, two of the three rooms were complete, and the AI service was feature-complete but not yet wired into the Unity client. Two changes followed from Beta testing. On the AI side, the heavy-intervention mode was dropped after testers found it intrusive: Ariadne would interject at every conversational pause, often without adding anything substantive. The experimental design was therefore narrowed to a single With AI vs. No AI comparison built on a refined version of the light-intervention prompt. On the client side, puzzle difficulty was reduced by adding more in-environment clues, in response to tester reports of getting stuck.

#### **4.4.3 Gold: Polish and User Study Readiness**

The Gold milestone covered final integration, performance work, and study readiness. The third escape-room space was completed and the AI service was wired into the Unity client, finishing the integration originally scoped for Beta. Standalone-hardware rendering was tuned, network latency in the AI loop was reduced, and UI, puzzle, and animation polish proceeded as planned. Behavioural logging (speaker turn-taking timestamps and task-completion timings, intended as the study's objective measures) was implemented in part but did not function reliably during the study sessions, which is why the evaluation in Section 7 relies on subjective measures alone.
