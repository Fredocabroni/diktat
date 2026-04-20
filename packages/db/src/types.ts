export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ap_transactions: {
        Row: {
          balance_after: number
          created_at: string
          delta: number
          id: string
          idempotency_key: string
          reason: string
          ref_id: string | null
          ref_type: string | null
          user_id: string
        }
        Insert: {
          balance_after: number
          created_at?: string
          delta: number
          id?: string
          idempotency_key: string
          reason: string
          ref_id?: string | null
          ref_type?: string | null
          user_id: string
        }
        Update: {
          balance_after?: number
          created_at?: string
          delta?: number
          id?: string
          idempotency_key?: string
          reason?: string
          ref_id?: string | null
          ref_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ap_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      battle_participants: {
        Row: {
          battle_id: string
          entry_ap: number
          joined_at: string
          result: string | null
          seat: number
          user_id: string
        }
        Insert: {
          battle_id: string
          entry_ap: number
          joined_at?: string
          result?: string | null
          seat: number
          user_id: string
        }
        Update: {
          battle_id?: string
          entry_ap?: number
          joined_at?: string
          result?: string | null
          seat?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "battle_participants_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_participants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      battle_rounds: {
        Row: {
          battle_id: string
          created_at: string
          id: string
          payload: Json
          round_no: number
          winner_user_id: string | null
        }
        Insert: {
          battle_id: string
          created_at?: string
          id?: string
          payload?: Json
          round_no: number
          winner_user_id?: string | null
        }
        Update: {
          battle_id?: string
          created_at?: string
          id?: string
          payload?: Json
          round_no?: number
          winner_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "battle_rounds_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_rounds_winner_user_id_fkey"
            columns: ["winner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      battles: {
        Row: {
          ap_pot: number
          created_at: string
          ended_at: string | null
          id: string
          mode: string
          started_at: string | null
          status: string
          topic_id: string | null
          updated_at: string
          winner_user_id: string | null
        }
        Insert: {
          ap_pot?: number
          created_at?: string
          ended_at?: string | null
          id?: string
          mode: string
          started_at?: string | null
          status?: string
          topic_id?: string | null
          updated_at?: string
          winner_user_id?: string | null
        }
        Update: {
          ap_pot?: number
          created_at?: string
          ended_at?: string | null
          id?: string
          mode?: string
          started_at?: string | null
          status?: string
          topic_id?: string | null
          updated_at?: string
          winner_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "battles_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "news_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battles_winner_user_id_fkey"
            columns: ["winner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      clips: {
        Row: {
          battle_id: string
          created_at: string
          duration_ms: number
          id: string
          published: boolean
          storage_path: string
          updated_at: string
        }
        Insert: {
          battle_id: string
          created_at?: string
          duration_ms: number
          id?: string
          published?: boolean
          storage_path: string
          updated_at?: string
        }
        Update: {
          battle_id?: string
          created_at?: string
          duration_ms?: number
          id?: string
          published?: boolean
          storage_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clips_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
        ]
      }
      fact_checks: {
        Row: {
          claim: string
          confidence: number | null
          created_at: string
          created_by_user_id: string | null
          evidence: Json
          id: string
          provider: string | null
          topic_id: string | null
          updated_at: string
          verdict: string
        }
        Insert: {
          claim: string
          confidence?: number | null
          created_at?: string
          created_by_user_id?: string | null
          evidence?: Json
          id?: string
          provider?: string | null
          topic_id?: string | null
          updated_at?: string
          verdict: string
        }
        Update: {
          claim?: string
          confidence?: number | null
          created_at?: string
          created_by_user_id?: string | null
          evidence?: Json
          id?: string
          provider?: string | null
          topic_id?: string | null
          updated_at?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "fact_checks_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fact_checks_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "news_topics"
            referencedColumns: ["id"]
          },
        ]
      }
      news_topics: {
        Row: {
          category: string | null
          created_at: string
          drop_at: string | null
          headline: string
          id: string
          is_drop: boolean
          primary_source_url: string | null
          published_at: string | null
          slug: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          drop_at?: string | null
          headline: string
          id?: string
          is_drop?: boolean
          primary_source_url?: string | null
          published_at?: string | null
          slug: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          drop_at?: string | null
          headline?: string
          id?: string
          is_drop?: boolean
          primary_source_url?: string | null
          published_at?: string | null
          slug?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      opinion_shifts: {
        Row: {
          after_position: number
          before_position: number
          created_at: string
          id: string
          topic_id: string
          user_id: string
        }
        Insert: {
          after_position: number
          before_position: number
          created_at?: string
          id?: string
          topic_id: string
          user_id: string
        }
        Update: {
          after_position?: number
          before_position?: number
          created_at?: string
          id?: string
          topic_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "opinion_shifts_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "news_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "opinion_shifts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions: {
        Row: {
          ap_payout: number | null
          ap_stake: number
          created_at: string
          direction: string
          id: string
          market_external_id: string | null
          settled_at: string | null
          status: string
          topic_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          ap_payout?: number | null
          ap_stake: number
          created_at?: string
          direction: string
          id?: string
          market_external_id?: string | null
          settled_at?: string | null
          status?: string
          topic_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          ap_payout?: number | null
          ap_stake?: number
          created_at?: string
          direction?: string
          id?: string
          market_external_id?: string | null
          settled_at?: string | null
          status?: string
          topic_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "predictions_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "news_topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "predictions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          app_version: string | null
          created_at: string
          device_kind: string | null
          ended_at: string | null
          id: string
          started_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          device_kind?: string | null
          ended_at?: string | null
          id?: string
          started_at?: string
          user_id: string
        }
        Update: {
          app_version?: string | null
          created_at?: string
          device_kind?: string | null
          ended_at?: string | null
          id?: string
          started_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      streaks: {
        Row: {
          created_at: string
          current_length: number
          freeze_tokens: number
          last_action_date: string | null
          longest_length: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_length?: number
          freeze_tokens?: number
          last_action_date?: string | null
          longest_length?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_length?: number
          freeze_tokens?: number
          last_action_date?: string | null
          longest_length?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "streaks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tiers: {
        Row: {
          ap_max: number | null
          ap_min: number
          cosmetics: Json
          created_at: string
          floor_protected: boolean
          id: number
          name: string
          payout_eligible: boolean
          updated_at: string
        }
        Insert: {
          ap_max?: number | null
          ap_min: number
          cosmetics?: Json
          created_at?: string
          floor_protected?: boolean
          id: number
          name: string
          payout_eligible?: boolean
          updated_at?: string
        }
        Update: {
          ap_max?: number | null
          ap_min?: number
          cosmetics?: Json
          created_at?: string
          floor_protected?: boolean
          id?: number
          name?: string
          payout_eligible?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      tribe_memberships: {
        Row: {
          is_primary: boolean
          joined_at: string
          tribe_id: string
          user_id: string
          weekly_ap: number
        }
        Insert: {
          is_primary?: boolean
          joined_at?: string
          tribe_id: string
          user_id: string
          weekly_ap?: number
        }
        Update: {
          is_primary?: boolean
          joined_at?: string
          tribe_id?: string
          user_id?: string
          weekly_ap?: number
        }
        Relationships: [
          {
            foreignKeyName: "tribe_memberships_tribe_id_fkey"
            columns: ["tribe_id"]
            isOneToOne: false
            referencedRelation: "tribes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tribe_memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tribes: {
        Row: {
          created_at: string
          description: string | null
          id: string
          manifesto: string | null
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          manifesto?: string | null
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          manifesto?: string | null
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      trivia_answers: {
        Row: {
          battle_id: string
          chosen_index: number
          correct: boolean
          created_at: string
          id: string
          latency_ms: number
          question_id: string
          round_id: string
          user_id: string
        }
        Insert: {
          battle_id: string
          chosen_index: number
          correct: boolean
          created_at?: string
          id?: string
          latency_ms: number
          question_id: string
          round_id: string
          user_id: string
        }
        Update: {
          battle_id?: string
          chosen_index?: number
          correct?: boolean
          created_at?: string
          id?: string
          latency_ms?: number
          question_id?: string
          round_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trivia_answers_battle_id_fkey"
            columns: ["battle_id"]
            isOneToOne: false
            referencedRelation: "battles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trivia_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "trivia_questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trivia_answers_round_id_fkey"
            columns: ["round_id"]
            isOneToOne: false
            referencedRelation: "battle_rounds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trivia_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      trivia_questions: {
        Row: {
          category: string
          choices: Json
          correct_index: number
          created_at: string
          difficulty: number
          id: string
          prompt: string
          source_url: string | null
          updated_at: string
          verified: boolean
          verified_by_user_id: string | null
        }
        Insert: {
          category: string
          choices: Json
          correct_index: number
          created_at?: string
          difficulty: number
          id?: string
          prompt: string
          source_url?: string | null
          updated_at?: string
          verified?: boolean
          verified_by_user_id?: string | null
        }
        Update: {
          category?: string
          choices?: Json
          correct_index?: number
          created_at?: string
          difficulty?: number
          id?: string
          prompt?: string
          source_url?: string | null
          updated_at?: string
          verified?: boolean
          verified_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trivia_questions_verified_by_user_id_fkey"
            columns: ["verified_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          current_ap: number
          display_name: string | null
          fingerprint: Json
          handle: string
          id: string
          onboarded_at: string | null
          tier_id: number
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          current_ap?: number
          display_name?: string | null
          fingerprint?: Json
          handle: string
          id: string
          onboarded_at?: string | null
          tier_id?: number
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          current_ap?: number
          display_name?: string | null
          fingerprint?: Json
          handle?: string
          id?: string
          onboarded_at?: string | null
          tier_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      wallets: {
        Row: {
          created_at: string
          display_currency: string
          external_wallet_id: string | null
          id: string
          provider: string
          status: string
          updated_at: string
          usdc_balance_micro: number
          user_id: string
        }
        Insert: {
          created_at?: string
          display_currency?: string
          external_wallet_id?: string | null
          id?: string
          provider?: string
          status?: string
          updated_at?: string
          usdc_balance_micro?: number
          user_id: string
        }
        Update: {
          created_at?: string
          display_currency?: string
          external_wallet_id?: string | null
          id?: string
          provider?: string
          status?: string
          updated_at?: string
          usdc_balance_micro?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      x_posts: {
        Row: {
          author_user_id: string | null
          body: string
          created_at: string
          external_post_id: string | null
          id: string
          pillar: string
          posted_at: string | null
          scheduled_for: string | null
          status: string
          updated_at: string
        }
        Insert: {
          author_user_id?: string | null
          body: string
          created_at?: string
          external_post_id?: string | null
          id?: string
          pillar: string
          posted_at?: string | null
          scheduled_for?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          author_user_id?: string | null
          body?: string
          created_at?: string
          external_post_id?: string | null
          id?: string
          pillar?: string
          posted_at?: string | null
          scheduled_for?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "x_posts_author_user_id_fkey"
            columns: ["author_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_self: { Args: { target_user_id: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
