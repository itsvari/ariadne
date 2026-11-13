# **\[Project Title\] Ariadne**: **Embodied LLMs for Collaborative Problem-Solving in VR**

**Team number:** PG01  
**Team member(s):** full names

# **1\. Abstract** 

This project investigates the role of large language models (LLMs) as embodied facilitators in collaborative virtual reality (VR) environments. While VR enables immersive remote collaboration, it also poses challenges, including uneven participation and conversational imbalance. To address this, we introduce Ariadne, an AI-powered embodied agent integrated into a shared VR escape room environment that actively guides group interaction and encourages balanced communication.

Through user studies, we evaluate how AI intervention influences collaboration dynamics, including participation equity, engagement, and problem-solving effectiveness. Our findings suggest that embodied AI facilitation \[can/cannot\] improve conversational balance and enhance user experience, with participants perceiving the AI as a \[supportive/unsupportive\] collaborator \[rather than/and\] a disruptive presence. This work contributes insights into human-AI collaboration, particularly in multi-user VR environments, and it highlights the potential of AI as a social facilitator in team-based problem-solving contexts.  

# **2\. Introduction**

### **2.1 Problem and Importance**

Remote collaboration has become increasingly common in work, education, and social contexts, yet it often lacks the richness and fluidity of in-person interaction. While VR offers immersive environments that simulate co-presence, challenges such as uneven participation and communication breakdowns remain. In group settings, dominant participants may control discussions while quieter participants contribute less, which leads to suboptimal collaboration outcomes. This issue becomes particularly critical in team-based problem-solving scenarios where balanced communication is essential. As XR technologies continue to evolve, understanding how to support effective collaboration within these environments is increasingly important. This serves as the foundational premise of our research and represents the core friction we aim to resolve. 

### **2.2 Current Solutions**

The existing solutions for remote collaboration fall under three main categories: video conferencing platforms, collaborative virtual environments, and AI-assisted tools. Platforms such as Zoom and Microsoft Teams enable real-time communication but are limited to 2D interfaces, which lack spatial interaction and embodied presence. As a result, they do not effectively communicate the dynamics of in-person group collaboration, leading to reduced engagement and uneven participation.

To address this, virtual reality platforms such as VRChat and Meta Horizon Workrooms introduce immersive and shared environments where users can interact through their avatars. While these systems improve social presence and co-presence \[4\], they still rely heavily on users to self-regulate communication. As a result, issues such as dominant speakers and passive participants persist, posing challenges in task-oriented settings \[5\].

Additionally, AI-powered tools, such as ChatGPT and other conversational agents, have been integrated into collaborative workflows to support tasks. However, these systems are typically designed for individual interaction rather than facilitating group dynamics \[1\]. They lack awareness of multi-user contexts and do not actively manage participation balance or coordination between users.

Overall, while existing solutions improve accessibility and immersion, they fall short in supporting balanced collaboration and communication within groups.

### **2.3 Our Solution**

To address these gaps, we propose *Ariadne*, an embodied AI facilitator integrated into a shared VR escape room environment. Unlike traditional AI tools that passively respond to user queries, Ariadne is designed to actively support group interaction by monitoring team progress and conversational dynamics in real time. 

There are two main ways that Ariadne intervenes: prompting quieter participants to contribute and encouraging coordination by reinforcing shared goals and clarifying next steps.

By using AI as a social actor within the environment, we aim to improve group cohesion, collaboration extent, and task experience. 

Hence, our research investigates the following question: Does LLM intervention in an embodied VR task influence group collaboration and communication dynamics? We hypothesise that an embodied AI facilitator can improve participation balance and enhance overall collaboration quality compared to environments without such intervention.

### **2.4 Contributions**

1. We designed and developed an embodied LLM-based AI facilitator for multi-user VR collaboration   
2. We evaluated the impact of AI intervention on communication dynamics and group participation  
3. We provide insights into the role of AI as a social facilitator in VR environments 

### **2.5 Organisation of Sections**

* Section 3: Review of related work in VR collaboration and conversational AI  
* Section 4: Description of the design of Ariadne  
* Section 5: Implementation of the VR and AI environment setup  
* Section 6: Outline of experimental evaluation methodology  
* Section 7: Presents and discusses the results  
* Section 8: Conclusion of the paper and research  
* Section 9: References

# **3\. Related Works**

### **3.1 Are We in This Together? Investigating the Relationship of Avatar Customisation, Social Presence, and Communication Outcomes in Collaborative Embodied Virtual Reality**

This study explores how avatar customisation influences social presence and relational communication in collaborative VR environments. Participants completed spatial puzzle tasks in VRChat using either customised or default avatars, with results showing no significant differences in perceived social presence or communication quality. The findings suggest that in task-oriented scenarios, the collaborative activity itself may play a more important role than visual representation. 

However, this study primarily focuses on appearance-based embodiment and does not address how interaction dynamics are managed within the group. In particular, it does not consider issues such as participation imbalance or communication breakdown. In contrast, our research extends the focus of visual embodiment to behavioural facilitation, introducing an AI agent that actively regulates group interactions. 

### **3.2 Engaged and Affective Virtual Agents: Their Impact on Social Presence, Trustworthiness, and Decision-Making in the Group Discussion**

This study investigates how emotionally responsive virtual agents (VAs) influence group decision-making and user engagement. Results showed that the VAs can increase attention and improve group consensus by enhancing engagement. However, the VA's affective behaviour negatively impacted perceived social presence and trustworthiness, as participants found emotional displays inappropriate or distracting for the task. 

A key limitation of this work is that the VAs are primarily designed for one-on-one interaction rather than multi-user collaboration. Our work extends this by designing an AI facilitator that operates within multi-user environments, focusing on guiding interaction flow and improving collaborative efficiency rather than emotional engagement alone.

### **3.3 Comparing Text-Only and Virtual Reality-Embodied Conversational AI Agents for Interpersonal Skills Training**

This study compares the effectiveness of text-based and embodied AI systems in training interpersonal skills. Results indicate that participants preferred the embodied agent and demonstrated stronger initial performance, highlighting the benefits of immersion and presence. However, long-term learning improvements were not significantly better in the VR condition.

While this work demonstrates the advantages of embodiment, it focuses on individual training scenarios rather than collaborative problem-solving. The role of the AI agent is also limited to interaction with a single user, without addressing group-level dynamics. To supplement this, our system explores how an embodied AI agent can function as a facilitator within a team setting, supporting coordination and communication across multiple participants.

### **3.4 Gap Analysis and Research Contributions**

Existing works highlight the importance of embodiment and social presence in VR, as well as the potential of AI agents to influence user behaviour. However, prior systems focus on visual representation, individual interaction, or affective engagement, and have limited insights into the active facilitation of group dynamics in multi-user environments.

Our project addresses this gap by introducing Ariadne, a multi-modal architecture that synthesises embodied AI, LLM-driven communication, and multi-user VR collaboration. Unlike prior approaches, Ariadne is designed to actively regulate participation, support communication, and guide team coordination in real time. This allows us to contribute new insights into how AI can function as a social facilitator in immersive collaborative settings.

# **4\. VR System Design**

### **4.1 System Overview**

Ariadne is designed as a multi-user VR escape room where participants collaborate to solve puzzles while their communication is facilitated by an embodied AI facilitator. The system consists of three main components: a shared escape room VR environment, participants' avatars, and an AI facilitator. The system is designed to encourage communication through structured interactions and AI-supported guidance.

### **4.2 Design Principles**

To support effective group collaboration, the system is designed around two key principles: communication dependency and AI-assisted facilitation.

First, interactions are structured such that players do not have complete information individually, encouraging them to communicate and coordinate to solve puzzles. 

Second, an embodied AI facilitator (Ariadne) is introduced to support group dynamics. The AI intervenes when necessary to guide discussion, encourage participation, and maintain conversational balance without directly solving the tasks.

### **4.3 UI/UX Considerations**

The UI/UX of Ariadne translates these design principles into interaction decisions that encourage communication while maintaining usability and comfort.

1. **Controlled Information Visibility**

A key design choice is how hints are revealed. While all players can access the same hint panels, each panel must be individually discovered and unlocked. This means when one player finds a hint, others must either locate it themselves or rely on verbal sharing. From a UI/UX perspective, this creates a communication dependency without fully restricting access. Players are encouraged to guide each other or describe what they see, making communication a natural part of gameplay rather than an added feature.

2. **AI as Part of the Interaction Design**

The AI facilitator (Ariadne) is integrated as part of the UI/UX through embodiment as an in-world avatar. Instead of providing direct solutions, it prompts players to share information, and redirects attention when the group is stuck. This helps improve group coordination while preserving collaborative problem-solving. 

3. **Environment Based Interaction**

To minimise cognitive load, we avoided traditional UI elements such as menus or text-heavy panels. Instead, interactions are embedded directly into the environment, such as hint panels, coloured pillars, visual cues. This allows players to focus on shared physical objects, making it easier to discuss, test ideas, and observe changes together.

4. **Simple and Consistent Interaction Design**

All interactions are kept simple and consistent (click, grab, place) with immediate visual feedback such as colour changes or light activation, reducing the learning curve for users who are new to VR. Furthermore, all key interactions are designed within a comfortable physical range, allowing users to interact with objects without excessive movement. The experience also avoids sudden camera movements or forced perspective changes, ensuring a stable and comfortable viewing experience throughout gameplay.

Overall, the UI/UX design focuses on enabling communication, maintaining clarity, and supporting user comfort, with the AI facilitator playing as a supporting role in improving group interaction rather than taking over the experience. 

### **4.4 Iteration and Testing**

#### 4.4.1 Alpha-phase

Implementation of basic game mechanics 

#### 4.4.2 Beta-phase

Implementation of multi-player VR

#### 4.4.3 Gold-phase

Refinement of the overall game and VR experience

# **5\. Implementation**

### **5.1 Game Mechanics**

### **5.2 LLM**

# **6\. Evaluation Method**

This study evaluates the effectiveness of a collaborative VR escape room system, focusing on how the presence and behaviour of an AI agent influence group dynamics, collaboration, and user experience. In particular, we are assessing whether the system design supports its intended purpose of facilitating team-based problem solving, while maintaining a positive and usable user experience. 

To evaluate this, we measure both objective and subjective metrics:

1) Objective metrics focus on behavioural outcomes during experimental gameplay. The primary measure is memory pooling, which measures the extent to which participants share clues with each other. This is collected through in-game logging, such as the number of clues communicated or shared between teammates. A higher frequency of shared information indicates stronger collaboration.

2) Subjective metrics are collected through post-questionnaires. Group cohesion is measured using the GCS-R Unity and Social Attraction subscales, which evaluate participants’ interpersonal bonding. Collaboration extent is assessed through Transactive Memory System (TMS) coordination and credibility subscales, which evaluate how well team members coordinate and trust each other’s knowledge. Cognitive load is measured using NASA-TLX (Mental Demand and Frustration), which indicates task difficulty and user strain. Lastly, perceived agent utility is evaluated through 7-point Likert scale questions on helpfulness and inspiration.

The user study is conducted in a controlled lab setting using VR headsets, where participants are grouped into teams of 2-3 to complete the escape room task. Participants are primarily university students with varying levels of VR and gaming experience. Demographic and control variables are also collected via a pre-questionnaire, with questions including interpersonal familiarity, VR experience, prior escape room experience, attitudes toward AI (GAAIS), and basic demographics (age). Additional control variables are also measured through the post-questionnaire, with questions such as VR sickness and goal clarity.

Together, these measures provide a comprehensive evaluation of both performance outcomes and user experience. This helps us to understand if our system design works and how it impacts collaborative behaviour.    

# **7\. Evaluation Results**

### **7.1 Findings**

Twenty-five participants across nine groups completed the VR escape room experience under one of two between-subject conditions: with AI facilitator (n \= 12, four groups) and without AI facilitator (n \= 13, five groups). Subjective outcomes were measured via post-experience questionnaires covering group cohesion, collaboration quality, and cognitive load. Between-condition differences were tested using independent samples t-tests, which compare the means of two independent groups and assume approximate normality within each group. Given the exploratory nature of the study, raw p-values are reported without correction for multiple comparisons, with significance set at p \< 0.05.

| Metric | Description | No AI |  | With AI |  | t | df | p |
| ----- | ----- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
|  |  | M | SD | M | SD |  |  |  |
| GCS Unity | Felt sense of shared purpose and commitment within the group | 3.71 | 0.72 | 2.46 | 1.10 | 3.35 | 18.8 | 0.003\* |
| GCS Social Attraction | Enjoyment of and liking for fellow group members | 4.48 | 0.58 | 4.08 | 0.71 | 1.52 | 21.3 | 0.142 |
| GCS Total | Overall group cohesion (mean of Unity and Social Attraction) | 4.10 | 0.46 | 3.27 | 0.74 | 3.34 | 18.1 | 0.004\* |
| TMS Credibility | Trust in and reliance on teammates’ task-relevant knowledge | 4.50 | 0.61 | 3.69 | 0.24 | 4.43 | 15.9 | 0.000\* |
| TMS Coordination | Smoothness and clarity of the team’s procedural workflow | 3.08 | 0.75 | 3.54 | 0.38 | \-1.97 | 18.1 | 0.065 |
| TMS Total | Overall collaboration quality (mean of Credibility and Coordination) | 3.79 | 0.55 | 3.61 | 0.27 | 1.02 | 17.7 | 0.324 |
| NASA Mental Demand | Perceived mental effort required to complete the tasks | 4.54 | 1.66 | 3.92 | 1.56 | 0.96 | 23.0 | 0.346 |
| NASA Frustration | Level of frustration, stress, or annoyance experienced during play | 3.77 | 1.69 | 2.58 | 1.44 | 1.89 | 22.9 | 0.071 |

***Table 1\.** Independent samples t-test results for all subjective metrics (n \= 13 No AI, n \= 12 With AI). Means (M) and standard deviations (SD) are on a 1-5 scale for the Group Cohesion Scale (GCS) and Transactive Memory System (TMS) items, and a 1-7 scale for NASA-TLX items. p-values are two-tailed.*

Three metrics reached statistical significance. GCS Unity was significantly higher in the No AI condition (t(18.8) \= 3.35, p \= 0.003), as was GCS Total (t(18.1) \= 3.34, p \= 0.004). TMS Credibility was also significantly higher in the No AI condition (t(15.0) \= 4.43, p \< 0.001). TMS Coordination trended in the opposite direction, with With AI teams scoring higher (t(18.1) \= \-1.97, 0.065), though this did not reach statistical significance. Neither NASA-TLX subscale reached significance, though Frustration showed a notable directional difference (M \= 2.58 vs. 3.77, p \= 0.071).

Agent utility was also assessed within the With AI condition only (n \= 12\) using a 7-point Likert scale. Mean scores were modest, with values displaying: Helpfulness(M \= 3.50, SD \= 1.51), Inspiration (M \= 3.33, SD \= 1.44), and Overall Appreciation (M \= 3.17, SD \= 1.11).

### **7.2 Discussion**

At a high level, the results reveal a trade-off introduced by the AI facilitator. Teams without the AI felt more strongly bonded and trusted each other’s knowledge more deeply, but also experienced greater frustration and cognitive effort. Teams with the AI reported a smoother and less stressful experience, yet felt less unified and relied less on their teammates’ expertise. The AI appears to have absorbed some of the cognitive and emotional load of the task, albeit at the cost of the teamwork that naturally emerges when a group must depend entirely on itself.

The significant drop in GCS Unity with AI present suggests that while Social Attraction remained largely unchanged across conditions (participants liked their teammates either way), the sense of shared purpose and collective commitment was notably weaker in the With AI condition. This suggests the AI may have drawn individual attention toward its own prompts and narration, dissolving the shared ownership of the task rather than reinforcing it.

A similar pattern is observed from the TMS results. The significant drop in TMS Credibility with AI suggests that participants came to rely on the AI as an alternative knowledge source, which may have reduced the need to actively build trust in and engage with their teammates’ contributions. The opposing trend in TMS Coordination, where teams with AI appeared to operate more smoothly, indicates the AI provided structural support for the task even as it weakened interpersonal trust. 

The cognitive load results, while non-significant, are directionally coherent with this interpretation. Teams with AI reported lower frustration on average, suggesting the facilitator did alleviate some emotional strain even if the effect was not strong enough to reach significance at this sample size. The substantial variance in agent utility scores further suggests a divided user experience; in essence, some participants found genuine value in the AI facilitator, while others were hindered by implementation issues such as audio volume and poorly timed interventions.

### **7.3 Limitations and Future Work**

Several limitations should be noted when interpreting these results. The sample size of 25 participants across nine groups is small, limiting statistical power, particularly at the group level where even large effects may remain undetected. The between-subjects design means that observed differences cannot be ascribed purely to the AI condition, as pre-existing group dynamics and individual differences in XR familiarity may confound results. A crossover or counterbalanced design would allow for stronger causal inference.

A further limitation lies in the study’s exclusive reliance on subjective, self-reported measures. All metrics were drawn from post-experience questionnaires, which are prone to recall bias, social desirability effects, and individual differences in how participants interpret Likert scales. The intended objective measure of memory pooling, capturing the frequency of clue-sharing between teammates, was not successfully captured during the study sessions. 

Future studies would benefit from a richer set of objective behavioural measures, such as automated speech analysis to capture turn-taking and conversational balance, gaze and proximity tracking within the virtual environment to measure spatial coordination, and timestamped logs of puzzle-solving progress to identify when teams stall or accelerate. Combining these with the existing subjective measures would allow self-reported experience to be triangulated against observable behaviour, producing a more robust and less bias-prone account of how AI facilitation shapes team dynamics.

Technical issues including audio volume, connection instability, and visual clarity affected some sessions, likely introducing noise into both behavioural and self-report measures.

Future work should prioritise a larger and more balanced sample, incorporate a within-subjects or matched-groups design to control for group-level variance, and address identified usability shortcomings (particularly AI voice prominence and context-aware intervention timing) before conducting a confirmatory study. Extending the evaluation to measure team outcomes across repeated collaborative sessions would also provide a more nuanced picture of how AI-mediated facilitation shapes group dynamics over time.

# **8\. Conclusion**

Ariadne demonstrates the potential of embodied LLMs as facilitators in collaborative VR environments. By integrating an AI agent into a shared problem-solving task (escape room), we address key challenges in remote collaboration, including uneven participation and a lack of conversational balance. Our findings show that AI \[can/cannot\] play a meaningful role in guiding group dynamics while maintaining user engagement and immersion. This research opens new possibilities for AI research in how it supports teamwork in VR environments. 

# **9\. References**

1) Bubeck, Sébastien & Chandrasekaran, Varun & Eldan, Ronen & Gehrke, Johannes & Horvitz, Eric & Kamar, Ece & Lee, Peter & Lee, Yin Tat & Li, Yuanzhi & Lundberg, Scott & Nori, Harsha & Palangi, Hamid & Ribeiro, Marco & Zhang, Yi. (2023). Sparks of Artificial General Intelligence: Early experiments with GPT-4. 10.48550/arXiv.2303.12712.   
2) Hanseob Kim, Bin Han, Jieun Kim, Muhammad Firdaus Syawaludin Lubis, Gerard Jounghyun Kim, and Jae-In Hwang. 2024\. Engaged and Affective Virtual Agents: Their Impact on Social Presence, Trustworthiness, and Decision-Making in the Group Discussion. In Proceedings of the CHI Conference on Human Factors in Computing Systems, May 11, 2024\. ACM, Honolulu HI USA, 1–17. [https://doi.org/10.1145/3613904.3642917](https://doi.org/10.1145/3613904.3642917)  
3) Anna-Leena Macey, Mila Bujić, Anatolii Belousov, Bojan Kerous, Simo Järvelä, and Juho Hamari. 2025\. Are We in This Together? Investigating the Relationship of Avatar Customisation, Social Presence, and Communication Outcomes in Collaborative Embodied Virtual Reality. Proc. ACM Hum.-Comput. Interact. 9, 7, Article CSCW371 (November 2025), 20 pages. [https://doi.org/10.1145/3757552](https://doi.org/10.1145/3757552)   
4) Oh, Catherine & Bailenson, Jeremy & Welch, Gregory. (2018). A Systematic Review of Social Presence: Definition, Antecedents, and Implications. Frontiers in Robotics and AI. 5\. 10.3389/frobt.2018.00114.  
5) Strauß, S., Rummel, N. Promoting regulation of equal participation in online collaboration by combining a group awareness tool and adaptive prompts. But does it even matter?. Intern. J. Comput.-Support. Collab. Learn 16, 67–104 (2021). https://doi.org/10.1007/s11412-021-09340-y  
6) Yejoon Yoo, Yilu Sun, Omar Shaikh, and Andrea Stevenson Won. 2025\. Comparing Text-Only and Virtual Reality-Embodied Conversational AI Agents for Interpersonal Skills Training. In Companion of the 2025 Conference on Computer-Supported Cooperative Work and Social Computing. ACM, Bergen, Norway, 194–198. [https://doi.org/10.1145/3715070.3749224](https://doi.org/10.1145/3715070.3749224)